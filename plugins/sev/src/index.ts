/**
 * @name Message Injector
 * @description Inject fake messages in DMs from anyone
 * @version 1.0.3
 */
import { FluxDispatcher } from "@vendetta/metro/common";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { logger } from "@vendetta";
import settingsComponent from "./settings";

// Initialize storage defaults
storage.enabled ??= true;
storage.debug ??= false;
storage.persistentMessages ??= {};
storage.autoInjectOnStartup ??= true;
storage.preventMessageDeletion ??= true;

const unpatches: (() => void)[] = [];
let ChannelStore: any = null;
let UserStore: any = null;
let MessageStore: any = null;
let SelectedChannelStore: any = null;
let PrivateChannelStore: any = null;
let RelationshipStore: any = null;
let currentChannelId: string | null = null;
let channelMonitorInterval: any = null;

// Track last injection time per channel to debounce aggressively
const lastReinjectTime: { [channelId: string]: number } = {};
const REINJECT_DEBOUNCE_MS = 3000; // Minimum 3 seconds between reinjections

// Track if we're in startup mode to only inject once
let isStartupComplete = false;

// Logging helpers
const log = (msg: string, data?: any) => {
    if (storage.debug) {
        logger.log(`[MessageInjector] ${msg}`, data || '');
    }
};

const logError = (msg: string, err?: any) => {
    logger.error(`[MessageInjector] ${msg}`, err || '');
};

// Delay helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Validate timestamp
function validateTimestamp(timestamp: string | undefined): string {
    if (!timestamp) {
        return new Date().toISOString();
    }
    
    try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) {
            logError('Invalid timestamp, using current time', timestamp);
            return new Date().toISOString();
        }
        return date.toISOString();
    } catch (e) {
        logError('Failed to parse timestamp, using current time', e);
        return new Date().toISOString();
    }
}

// Validate and sanitize user ID
function validateUserId(userId: string): boolean {
    if (!userId || typeof userId !== 'string') {
        return false;
    }
    // Discord snowflake IDs are numeric strings
    return /^\d+$/.test(userId.trim());
}

// Validate embed
function validateEmbed(embed: any): any | undefined {
    if (!embed) return undefined;
    
    try {
        const validEmbed: any = {
            type: 'rich'
        };
        
        if (embed.title && typeof embed.title === 'string') {
            validEmbed.title = embed.title.substring(0, 256);
        }
        
        if (embed.description && typeof embed.description === 'string') {
            validEmbed.description = embed.description.substring(0, 4096);
        }
        
        if (embed.image?.url && typeof embed.image.url === 'string') {
            validEmbed.image = { url: embed.image.url };
        }
        
        if (embed.thumbnail?.url && typeof embed.thumbnail.url === 'string') {
            validEmbed.thumbnail = { url: embed.thumbnail.url };
        }
        
        return Object.keys(validEmbed).length > 1 ? validEmbed : undefined;
    } catch (e) {
        logError('Failed to validate embed', e);
        return undefined;
    }
}

// Find store helper
function findStore(names: string[], methods: string[] = []): any {
    for (const name of names) {
        try {
            const store = findByStoreName(name);
            if (store) {
                const hasAll = methods.length === 0 || methods.every(m => typeof store[m] === 'function');
                if (hasAll) {
                    log(`Found store: ${name}`);
                    return store;
                }
            }
        } catch (e) { }
    }

    if (methods.length > 0) {
        try {
            const store = findByProps(...methods);
            if (store) {
                log(`Found store by props: ${methods.join(', ')}`);
                return store;
            }
        } catch (e) { }
    }

    return null;
}

// Get comprehensive user info including avatar decorations and guild tag
async function getUserInfo(userId: string): Promise<{ 
    username: string; 
    avatar: string | null; 
    discriminator: string;
    global_name?: string;
    avatar_decoration_data?: any;
    public_flags?: number;
    clan?: any;
}> {
    try {
        if (UserStore) {
            const user = UserStore.getUser?.(userId);
            if (user) {
                const info: any = {
                    username: user.username || 'Unknown User',
                    discriminator: user.discriminator || '0',
                    global_name: user.globalName || user.global_name || undefined,
                    avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}` : null,
                    public_flags: user.publicFlags || user.public_flags || 0
                };

                // Get avatar decoration data
                if (user.avatarDecorationData || user.avatar_decoration_data) {
                    const decorationData = user.avatarDecorationData || user.avatar_decoration_data;
                    info.avatar_decoration_data = {
                        asset: decorationData.asset,
                        sku_id: decorationData.skuId || decorationData.sku_id
                    };
                } else if (user.avatarDecoration || user.avatar_decoration) {
                    // Fallback for older format
                    const decoration = user.avatarDecoration || user.avatar_decoration;
                    info.avatar_decoration_data = {
                        asset: decoration,
                        sku_id: undefined
                    };
                }

                // Get clan/primary guild tag (server tags)
                // Check both clan (legacy) and primaryGuild (current) fields
                const clanData = user.clan || user.primaryGuild || user.primary_guild;
                if (clanData) {
                    info.clan = {
                        identity_guild_id: clanData.identityGuildId || clanData.identity_guild_id || null,
                        identity_enabled: clanData.identityEnabled ?? clanData.identity_enabled ?? false,
                        tag: clanData.tag || null,
                        badge: clanData.badge || null
                    };
                }

                return info;
            }
        }
    } catch (e) {
        logError('Failed to get user info', e);
    }

    return {
        username: 'Unknown User',
        discriminator: '0',
        avatar: null,
        public_flags: 0
    };
}

// Get DM channel ID from user ID
function getDMChannelId(userId: string): string | null {
    try {
        if (ChannelStore?.getDMFromUserId) {
            const channelId = ChannelStore.getDMFromUserId(userId);
            log(`DM channel for user ${userId}: ${channelId}`);
            return channelId;
        }
    } catch (e) {
        logError('Failed to get DM channel', e);
    }
    return null;
}

// Ensure DM channel exists and is in the channel list
async function ensureDMChannel(userId: string): Promise<string | null> {
    try {
        // First, try to get existing DM channel
        let channelId = getDMChannelId(userId);
        
        // If no channel exists, try to create it via opening a DM
        if (!channelId && PrivateChannelStore) {
            try {
                // Try to find or create DM channel
                const channels = PrivateChannelStore.getPrivateChannelIds?.();
                if (channels) {
                    // Check if there's already a DM with this user in the list
                    for (const id of channels) {
                        const channel = ChannelStore?.getChannel?.(id);
                        if (channel?.type === 1 && channel.recipients?.includes(userId)) {
                            channelId = id;
                            break;
                        }
                    }
                }
                
                // If still no channel, dispatch an action to open/create DM
                if (!channelId) {
                    // This simulates opening a DM which should create the channel
                    FluxDispatcher.dispatch({
                        type: 'CHANNEL_SELECT',
                        channelId: null,
                        guildId: null
                    });
                    
                    await delay(100);
                    
                    // Try getting the channel ID again
                    channelId = getDMChannelId(userId);
                }
            } catch (e) {
                logError('Failed to ensure DM channel', e);
            }
        }
        
        return channelId;
    } catch (e) {
        logError('Failed to ensure DM channel', e);
        return null;
    }
}

// Generate unique message ID (Discord snowflake-like)
function generateMessageId(): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 4096);
    return `${timestamp}${random.toString().padStart(4, '0')}`;
}

// Create message object with validation and full user data
async function createMessageObject(options: {
    channelId: string;
    userId: string;
    content?: string;
    username?: string;
    avatar?: string;
    embed?: any;
    timestamp?: string;
    messageId?: string;
}): Promise<any> {

    // Validate user ID
    if (!validateUserId(options.userId)) {
        throw new Error('Invalid user ID');
    }

    // Get full user info including decorations
    const userInfo = await getUserInfo(options.userId);
    
    let username = options.username || userInfo.username;
    let avatar = options.avatar || userInfo.avatar;

    // Validate and sanitize timestamp
    const timestamp = validateTimestamp(options.timestamp);

    // Validate embed
    const validEmbed = validateEmbed(options.embed);

    const message = {
        id: options.messageId || generateMessageId(),
        channel_id: options.channelId,
        author: {
            id: options.userId,
            username: username || 'Unknown User',
            global_name: userInfo.global_name,
            discriminator: userInfo.discriminator || '0',
            avatar: avatar ? avatar.split('/').pop()?.split('.')[0] : null,
            avatar_decoration_data: userInfo.avatar_decoration_data,
            clan: userInfo.clan,
            public_flags: userInfo.public_flags || 0,
            bot: false
        },
        content: (options.content || '').substring(0, 2000), // Discord message limit
        timestamp: timestamp,
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: validEmbed ? [validEmbed] : [],
        reactions: [],
        pinned: false,
        type: 0,
        flags: 0
    };

    log('Created message object', message);
    return message;
}

// FIX 1: Acknowledge messages to mark as read and prevent notifications
function acknowledgeMessages(channelId: string, messageId: string) {
    try {
        if (!FluxDispatcher) return;
        
        // Dispatch MESSAGE_ACK to mark the channel as read up to this message
        FluxDispatcher.dispatch({
            type: 'MESSAGE_ACK',
            channelId: channelId,
            messageId: messageId,
            manual: false,
            local: true
        });
        
        log(`Acknowledged message ${messageId} in channel ${channelId}`);
    } catch (e) {
        logError('Failed to acknowledge message', e);
    }
}

// FIX 2: Update channel state to keep DM in list
function updateChannelState(channelId: string, message: any) {
    try {
        if (!FluxDispatcher) return;
        
        // Dispatch CHANNEL_UPDATES to ensure the channel stays in the DM list
        FluxDispatcher.dispatch({
            type: 'CHANNEL_UPDATES',
            channels: [{
                id: channelId,
                last_message_id: message.id,
                // This ensures the channel is marked as having activity
            }]
        });
        
        log(`Updated channel state for ${channelId}`);
    } catch (e) {
        logError('Failed to update channel state', e);
    }
}

// Inject message into Discord - silent parameter prevents notifications on reinjection
function injectMessage(message: any, silent: boolean = false): boolean {
    if (!FluxDispatcher) {
        logError('FluxDispatcher not available');
        return false;
    }

    try {
        // FIX 1 & 2: Changed the dispatch to not use local: true flag
        // This ensures the DM stays in the list and proper state updates occur
        FluxDispatcher.dispatch({
            type: 'MESSAGE_CREATE',
            channelId: message.channel_id,
            message: message,
            optimistic: false,
            sendMessageOptions: {},
            isPushNotification: false,
            // REMOVED local: true to fix DM disappearing from list
            // Only mark as silent to reduce notification spam
            ...(silent && { 
                silent: true
            })
        });

        log(`Message ${silent ? 'silently ' : ''}injected successfully`, message.id);
        
        // FIX 1: After injecting, acknowledge the message to prevent notifications
        if (silent) {
            setTimeout(() => {
                acknowledgeMessages(message.channel_id, message.id);
            }, 100);
        }
        
        // FIX 2: Update channel state to ensure DM stays visible
        setTimeout(() => {
            updateChannelState(message.channel_id, message);
        }, 150);
        
        return true;
    } catch (e) {
        logError('Failed to inject message', e);
        return false;
    }
}

// Save persistent messages to storage with error recovery
function savePersistentMessages() {
    try {
        // Validate storage before saving
        if (typeof storage.persistentMessages !== 'object') {
            storage.persistentMessages = {};
        }

        // Remove any corrupted entries
        Object.keys(storage.persistentMessages).forEach(channelId => {
            if (!Array.isArray(storage.persistentMessages[channelId])) {
                delete storage.persistentMessages[channelId];
            }
        });

        storage.persistentMessages = JSON.parse(JSON.stringify(storage.persistentMessages));
        log('Saved persistent messages', Object.keys(storage.persistentMessages).length);
    } catch (e) {
        logError('Failed to save persistent messages', e);
        // Recovery: reset storage if corrupted
        storage.persistentMessages = {};
    }
}

// Main function: Fake a message
export async function fakeMessage(options: {
    targetUserId?: string;
    channelId?: string;
    fromUserId: string;
    content?: string;
    username?: string;
    avatar?: string;
    embed?: any;
    persistent?: boolean;
}): Promise<boolean> {

    try {
        // Validate sender user ID
        if (!validateUserId(options.fromUserId)) {
            logError('Invalid sender user ID');
            if (showToast) showToast('❌ Invalid sender user ID', 'Small');
            return false;
        }

        // Get channel ID
        let channelId = options.channelId;
        if (!channelId && options.targetUserId) {
            if (!validateUserId(options.targetUserId)) {
                logError('Invalid target user ID');
                if (showToast) showToast('❌ Invalid target user ID', 'Small');
                return false;
            }
            
            // Ensure DM channel exists
            channelId = await ensureDMChannel(options.targetUserId);
        }

        if (!channelId) {
            logError('No valid channel ID found');
            if (showToast) showToast('❌ Could not find DM channel', 'Small');
            return false;
        }

        // Create message with validation and full user data
        const message = await createMessageObject({
            channelId,
            userId: options.fromUserId,
            content: options.content,
            username: options.username,
            avatar: options.avatar,
            embed: options.embed
        });

        // Save to persistent storage if requested
        if (options.persistent) {
            if (!storage.persistentMessages[channelId]) {
                storage.persistentMessages[channelId] = [];
            }
            storage.persistentMessages[channelId].push(message);
            savePersistentMessages();
            log('Message saved to persistent storage', message.id);
        }

        // Inject the message (not silent for new messages)
        const success = injectMessage(message, false);

        if (success) {
            log('Fake message sent successfully');
        }

        return success;
    } catch (e) {
        logError('Failed to send fake message', e);
        if (showToast) showToast('❌ Failed to send message', 'Small');
        return false;
    }
}

// Reinject all messages for a specific channel with aggressive debouncing
function reinjectMessagesForChannel(channelId: string, force: boolean = false) {
    if (!storage.persistentMessages[channelId]) return;

    // Aggressive debounce: don't reinject if we've done it recently (unless forced)
    const now = Date.now();
    if (!force && lastReinjectTime[channelId] && (now - lastReinjectTime[channelId]) < REINJECT_DEBOUNCE_MS) {
        log(`Skipping reinject for ${channelId} - too soon (${now - lastReinjectTime[channelId]}ms ago)`);
        return;
    }

    const messages = storage.persistentMessages[channelId];
    
    // Validate messages array
    if (!Array.isArray(messages)) {
        delete storage.persistentMessages[channelId];
        savePersistentMessages();
        return;
    }

    log(`Reinjecting ${messages.length} messages for channel ${channelId}`);
    lastReinjectTime[channelId] = now;

    let latestMessageId = messages[messages.length - 1]?.id;

    // Reinject silently to prevent notification spam
    messages.forEach((message: any, index: number) => {
        setTimeout(() => {
            try {
                injectMessage(message, true); // Silent = true for reinjections
            } catch (e) {
                logError('Failed to reinject message', e);
            }
        }, index * 50);
    });
    
    // FIX 1: After all messages are reinjected, acknowledge the latest one
    // This marks the entire channel as read and prevents notification badges
    if (latestMessageId) {
        setTimeout(() => {
            acknowledgeMessages(channelId, latestMessageId);
        }, messages.length * 50 + 200);
    }
}

// Setup message persistence with minimal event triggers
function setupMessagePersistence() {
    try {
        if (!FluxDispatcher) return;

        const unpatch = before('dispatch', FluxDispatcher, (args: any[]) => {
            if (!storage.enabled) return;

            const event = args[0];
            if (!event || !event.type) return;

            // Prevent deletion of fake messages
            if (storage.preventMessageDeletion && event.type === 'MESSAGE_DELETE') {
                const messageId = event.id;
                const channelId = event.channelId;

                if (channelId && storage.persistentMessages[channelId]) {
                    const messages = storage.persistentMessages[channelId];
                    const fakeMessage = messages.find((m: any) => m.id === messageId);

                    if (fakeMessage) {
                        log('Prevented deletion of fake message', messageId);
                        args[0] = { type: 'NOOP' };
                        setTimeout(() => injectMessage(fakeMessage, true), 100);
                    }
                }
            }

            // Handle bulk deletions
            if (storage.preventMessageDeletion && event.type === 'MESSAGE_DELETE_BULK') {
                const channelId = event.channelId;
                if (channelId && storage.persistentMessages[channelId]) {
                    const ids = event.ids || [];
                    const messages = storage.persistentMessages[channelId];
                    const hasFake = messages.some((m: any) => ids.includes(m.id));

                    if (hasFake) {
                        args[0] = { type: 'NOOP' };
                        setTimeout(() => reinjectMessagesForChannel(channelId, true), 200);
                    }
                }
            }

            // Only reinject on actual message loads (when switching channels or loading history)
            if (event.type === 'LOAD_MESSAGES_SUCCESS') {
                const channelId = event.channelId;
                if (channelId && storage.persistentMessages[channelId]) {
                    // Single delayed reinject after load
                    setTimeout(() => reinjectMessagesForChannel(channelId), 500);
                }
            }

            // Reinject only on app connection open (app restart)
            if (event.type === 'CONNECTION_OPEN' && isStartupComplete) {
                // Reinject for all channels on reconnect
                Object.keys(storage.persistentMessages).forEach(channelId => {
                    setTimeout(() => {
                        reinjectMessagesForChannel(channelId, true);
                    }, 1000);
                });
            }
        });

        unpatches.push(unpatch);
        log('Message persistence system setup with minimal event coverage');
    } catch (e) {
        logError('Failed to setup message persistence', e);
    }
}

// Monitor channel changes ONLY (no aggressive reinjection)
function startChannelMonitoring() {
    // Only monitor for channel switches
    channelMonitorInterval = setInterval(() => {
        if (!SelectedChannelStore) return;

        try {
            const selectedChannel = SelectedChannelStore.getChannelId?.();
            if (selectedChannel && selectedChannel !== currentChannelId) {
                const previousChannel = currentChannelId;
                currentChannelId = selectedChannel;

                log(`Channel switched from ${previousChannel} to ${selectedChannel}`);

                // Only reinject when switching TO a channel with fake messages
                if (storage.persistentMessages[selectedChannel]) {
                    setTimeout(() => {
                        reinjectMessagesForChannel(selectedChannel);
                    }, 300);
                }
            }
        } catch (e) { }
    }, 1000);
}

// Clear all fake messages
export function clearAllMessages() {
    storage.persistentMessages = {};
    savePersistentMessages();
    log('Cleared all persistent messages');
    if (showToast) showToast('✅ All fake messages cleared', 'Check');
}

// Clear messages for specific channel
export function clearChannelMessages(channelId: string) {
    if (storage.persistentMessages[channelId]) {
        delete storage.persistentMessages[channelId];
        savePersistentMessages();
        log(`Cleared messages for channel ${channelId}`);
        if (showToast) showToast('✅ Channel messages cleared', 'Check');
    }
}

// Get all persistent messages
export function getAllMessages() {
    return storage.persistentMessages;
}

// Quick test function
export async function quickTest(targetUserId: string, fromUserId: string) {
    return await fakeMessage({
        targetUserId,
        fromUserId,
        content: 'Test message from Message Injector plugin! 🎉',
        persistent: true
    });
}

// Initialize modules
async function initModules() {
    try {
        ChannelStore = findStore(['ChannelStore'], ['getChannel', 'getDMFromUserId']);
        UserStore = findStore(['UserStore', 'CurrentUserStore'], ['getUser', 'getCurrentUser']);
        MessageStore = findStore(['MessageStore'], ['getMessages', 'getMessage']);
        SelectedChannelStore = findStore(['SelectedChannelStore'], ['getChannelId']);
        PrivateChannelStore = findStore(['PrivateChannelStore'], ['getPrivateChannelIds']);
        RelationshipStore = findStore(['RelationshipStore'], ['getRelationships']);

        const ready = ChannelStore && UserStore;

        if (ready) {
            log('All critical modules loaded');
        } else {
            logError('Some modules failed to load');
        }

        return ready;
    } catch (e) {
        logError('Failed to initialize modules', e);
        return false;
    }
}

// Recover from corrupted storage
function recoverStorage() {
    try {
        if (typeof storage.persistentMessages !== 'object' || storage.persistentMessages === null) {
            logger.warn('[MessageInjector] Corrupted storage detected, resetting...');
            storage.persistentMessages = {};
            return;
        }

        // Clean up invalid entries
        Object.keys(storage.persistentMessages).forEach(channelId => {
            if (!Array.isArray(storage.persistentMessages[channelId])) {
                delete storage.persistentMessages[channelId];
            } else {
                // Validate each message has required fields
                storage.persistentMessages[channelId] = storage.persistentMessages[channelId].filter((msg: any) => {
                    return msg && msg.id && msg.channel_id && msg.author && msg.timestamp;
                });

                // Remove empty arrays
                if (storage.persistentMessages[channelId].length === 0) {
                    delete storage.persistentMessages[channelId];
                }
            }
        });

        savePersistentMessages();
    } catch (e) {
        logError('Failed to recover storage', e);
        storage.persistentMessages = {};
    }
}

// Plugin lifecycle
export default {
    onLoad: async () => {
        try {
            logger.log('[MessageInjector] Loading...');

            // Recover from any storage corruption
            recoverStorage();

            await delay(1000);

            const modulesReady = await initModules();
            if (!modulesReady) {
                logError('Failed to load critical modules');
                if (showToast) showToast('❌ Plugin failed to load', 'Small');
                return;
            }

            setupMessagePersistence();
            startChannelMonitoring();

            // Do initial injection only once on startup
            if (storage.autoInjectOnStartup) {
                await delay(2000);
                const channelCount = Object.keys(storage.persistentMessages).length;
                if (channelCount > 0) {
                    log(`Auto-injecting messages for ${channelCount} channels on startup`);
                    Object.keys(storage.persistentMessages).forEach(channelId => {
                        setTimeout(() => {
                            reinjectMessagesForChannel(channelId, true);
                        }, 500);
                    });
                }
                
                // Mark startup complete after initial injection
                setTimeout(() => {
                    isStartupComplete = true;
                    log('Startup injection complete');
                }, 3000);
            } else {
                isStartupComplete = true;
            }

            // Expose API to window for console access
            (window as any).__MESSAGE_FAKER__ = {
                fakeMessage,
                clearAllMessages,
                clearChannelMessages,
                getAllMessages,
                quickTest,
                reinjectChannel: (channelId: string) => reinjectMessagesForChannel(channelId, true),
                getStatus: () => ({
                    enabled: storage.enabled,
                    messageCount: Object.values(storage.persistentMessages).reduce((acc: number, msgs: any) => acc + msgs.length, 0),
                    channelCount: Object.keys(storage.persistentMessages).length
                })
            };

            logger.log('[MessageInjector] ✅ Loaded successfully');

        } catch (e) {
            logError('Fatal error during load', e);
            if (showToast) showToast('❌ Plugin failed to load', 'Small');
        }
    },

    onUnload: () => {
        try {
            for (const unpatch of unpatches) {
                try {
                    unpatch();
                } catch (e) { }
            }

            unpatches.length = 0;

            if (channelMonitorInterval) {
                clearInterval(channelMonitorInterval);
                channelMonitorInterval = null;
            }

            if ((window as any).__MESSAGE_FAKER__) {
                delete (window as any).__MESSAGE_FAKER__;
            }

            logger.log('[MessageInjector] Unloaded');
            if (showToast) showToast('Plugin unloaded', 'Check');
        } catch (e) {
            logError('Error during unload', e);
        }
    },

    settings: settingsComponent,
};
