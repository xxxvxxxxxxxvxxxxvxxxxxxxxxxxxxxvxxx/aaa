/**
 * @name Message Injector
 * @description Inject fake messages in DMs from anyone
 * @version 1.0.1
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
let aggressiveMonitorInterval: any = null;

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

// Inject message into Discord
function injectMessage(message: any): boolean {
    if (!FluxDispatcher) {
        logError('FluxDispatcher not available');
        return false;
    }

    try {
        FluxDispatcher.dispatch({
            type: 'MESSAGE_CREATE',
            channelId: message.channel_id,
            message: message,
            optimistic: false,
            sendMessageOptions: {},
            isPushNotification: false
        });

        log('Message injected successfully', message.id);
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

        // Inject the message
        const success = injectMessage(message);

        if (success) {
            log('Fake message sent successfully');
            
            // Ensure the DM appears in the channel list by dispatching a channel select
            try {
                FluxDispatcher.dispatch({
                    type: 'CHANNEL_SELECT',
                    channelId: channelId,
                    guildId: null
                });
                
                await delay(50);
                
                // Then switch back to whatever was selected before
                if (currentChannelId && currentChannelId !== channelId) {
                    FluxDispatcher.dispatch({
                        type: 'CHANNEL_SELECT',
                        channelId: currentChannelId,
                        guildId: null
                    });
                }
            } catch (e) {
                log('Could not ensure channel visibility', e);
            }
        }

        return success;
    } catch (e) {
        logError('Failed to send fake message', e);
        if (showToast) showToast('❌ Failed to send message', 'Small');
        return false;
    }
}

// Reinject all messages for a specific channel
function reinjectMessagesForChannel(channelId: string) {
    if (!storage.persistentMessages[channelId]) return;

    const messages = storage.persistentMessages[channelId];
    
    // Validate messages array
    if (!Array.isArray(messages)) {
        delete storage.persistentMessages[channelId];
        savePersistentMessages();
        return;
    }

    log(`Reinjecting ${messages.length} messages for channel ${channelId}`);

    messages.forEach((message: any, index: number) => {
        setTimeout(() => {
            try {
                injectMessage(message);
            } catch (e) {
                logError('Failed to reinject message', e);
            }
        }, index * 50);
    });
}

// Setup message persistence
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
                        setTimeout(() => injectMessage(fakeMessage), 50);
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
                        setTimeout(() => reinjectMessagesForChannel(channelId), 100);
                    }
                }
            }

            // Reinject on message load
            if (event.type === 'LOAD_MESSAGES_SUCCESS' || event.type === 'LOAD_MESSAGES') {
                const channelId = event.channelId;
                if (channelId && storage.persistentMessages[channelId]) {
                    setTimeout(() => reinjectMessagesForChannel(channelId), 200);
                    setTimeout(() => reinjectMessagesForChannel(channelId), 500);
                    setTimeout(() => reinjectMessagesForChannel(channelId), 1000);
                }
            }

            // Reinject on cache/overlay events
            if (event.type === 'CACHE_LOADED' ||
                event.type === 'OVERLAY_INITIALIZE' ||
                event.type === 'CHANNEL_UPDATES' ||
                event.type === 'CONNECTION_OPEN') {
                if (currentChannelId && storage.persistentMessages[currentChannelId]) {
                    setTimeout(() => currentChannelId && reinjectMessagesForChannel(currentChannelId), 300);
                }
            }

            // Handle profile opens/closes and UI updates
            if (event.type === 'USER_PROFILE_MODAL_OPEN' ||
                event.type === 'USER_PROFILE_MODAL_CLOSE' ||
                event.type === 'LAYER_PUSH' ||
                event.type === 'LAYER_POP' ||
                event.type === 'TYPING_START' ||
                event.type === 'TYPING_STOP') {
                if (currentChannelId && storage.persistentMessages[currentChannelId]) {
                    setTimeout(() => currentChannelId && reinjectMessagesForChannel(currentChannelId), 50);
                    setTimeout(() => currentChannelId && reinjectMessagesForChannel(currentChannelId), 300);
                }
            }

            // On any message update, reinject to maintain presence
            if (event.type === 'MESSAGE_UPDATE') {
                const channelId = event.message?.channel_id;
                if (channelId && storage.persistentMessages[channelId]) {
                    setTimeout(() => reinjectMessagesForChannel(channelId), 100);
                }
            }
        });

        unpatches.push(unpatch);
        log('Message persistence system setup with comprehensive event coverage');
    } catch (e) {
        logError('Failed to setup message persistence', e);
    }
}

// Monitor channel changes and reinject messages
function startChannelMonitoring() {
    // Fast interval for immediate response
    channelMonitorInterval = setInterval(() => {
        if (!SelectedChannelStore) return;

        try {
            const selectedChannel = SelectedChannelStore.getChannelId?.();
            if (selectedChannel && selectedChannel !== currentChannelId) {
                currentChannelId = selectedChannel;

                if (storage.persistentMessages[selectedChannel]) {
                    reinjectMessagesForChannel(selectedChannel);
                    setTimeout(() => {
                        reinjectMessagesForChannel(selectedChannel);
                    }, 200);
                }
            }
        } catch (e) { }
    }, 1000);

    // Additional aggressive monitor for UI changes
    aggressiveMonitorInterval = setInterval(() => {
        if (currentChannelId && storage.persistentMessages[currentChannelId]) {
            reinjectMessagesForChannel(currentChannelId);
        }
    }, 2000);
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

            if (storage.autoInjectOnStartup) {
                await delay(2000);
                const channelCount = Object.keys(storage.persistentMessages).length;
                if (channelCount > 0) {
                    log(`Auto-injecting messages for ${channelCount} channels`);
                    Object.keys(storage.persistentMessages).forEach(channelId => {
                        setTimeout(() => {
                            reinjectMessagesForChannel(channelId);
                        }, 500);
                    });
                }
            }

            // Expose API to window for console access
            (window as any).__MESSAGE_FAKER__ = {
                fakeMessage,
                clearAllMessages,
                clearChannelMessages,
                getAllMessages,
                quickTest,
                reinjectChannel: reinjectMessagesForChannel,
                getStatus: () => ({
                    enabled: storage.enabled,
                    messageCount: Object.values(storage.persistentMessages).reduce((acc: number, msgs: any) => acc + msgs.length, 0),
                    channelCount: Object.keys(storage.persistentMessages).length
                })
            };

            logger.log('[MessageInjector] ✅ Loaded successfully');
            // REMOVED: Load notification toast

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

            if (aggressiveMonitorInterval) {
                clearInterval(aggressiveMonitorInterval);
                aggressiveMonitorInterval = null;
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
