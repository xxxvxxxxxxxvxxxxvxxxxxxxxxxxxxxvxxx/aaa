/**
 * @name Message Injector
 * @description Inject fake messages with DM List Persistence
 * @version 4.0.0
 */
import { FluxDispatcher } from "@vendetta/metro/common";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { before, after } from "@vendetta/patcher";
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
storage.fakeDMChannels ??= {}; // Track which channels should stay in DM list

const unpatches: (() => void)[] = [];
let ChannelStore: any = null;
let UserStore: any = null;
let MessageStore: any = null;
let SelectedChannelStore: any = null;
let PrivateChannelStore: any = null;
let RelationshipStore: any = null;
let currentChannelId: string | null = null;
let channelMonitorInterval: any = null;

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

// Get user info
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

                if (user.avatarDecorationData || user.avatar_decoration_data) {
                    const decorationData = user.avatarDecorationData || user.avatar_decoration_data;
                    info.avatar_decoration_data = {
                        asset: decorationData.asset,
                        sku_id: decorationData.skuId || decorationData.sku_id
                    };
                } else if (user.avatarDecoration || user.avatar_decoration) {
                    const decoration = user.avatarDecoration || user.avatar_decoration;
                    info.avatar_decoration_data = {
                        asset: decoration,
                        sku_id: undefined
                    };
                }

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

// Ensure DM channel exists
async function ensureDMChannel(userId: string): Promise<string | null> {
    try {
        let channelId = getDMChannelId(userId);
        
        if (!channelId && PrivateChannelStore) {
            try {
                const channels = PrivateChannelStore.getPrivateChannelIds?.();
                if (channels) {
                    for (const id of channels) {
                        const channel = ChannelStore?.getChannel?.(id);
                        if (channel?.type === 1 && channel.recipients?.includes(userId)) {
                            channelId = id;
                            break;
                        }
                    }
                }
                
                if (!channelId) {
                    FluxDispatcher.dispatch({
                        type: 'CHANNEL_SELECT',
                        channelId: null,
                        guildId: null
                    });
                    
                    await delay(100);
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

// Generate unique message ID
function generateMessageId(): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 4096);
    return `${timestamp}${random.toString().padStart(4, '0')}`;
}

// Create message object
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

    if (!validateUserId(options.userId)) {
        throw new Error('Invalid user ID');
    }

    const userInfo = await getUserInfo(options.userId);
    
    let username = options.username || userInfo.username;
    let avatar = options.avatar || userInfo.avatar;

    const timestamp = validateTimestamp(options.timestamp);
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
        content: (options.content || '').substring(0, 2000),
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

// Inject message
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
            optimistic: false
        });

        log('Message injected successfully', message.id);
        return true;
    } catch (e) {
        logError('Failed to inject message', e);
        return false;
    }
}

// Save persistent messages
function savePersistentMessages() {
    try {
        if (typeof storage.persistentMessages !== 'object') {
            storage.persistentMessages = {};
        }

        Object.keys(storage.persistentMessages).forEach(channelId => {
            if (!Array.isArray(storage.persistentMessages[channelId])) {
                delete storage.persistentMessages[channelId];
            }
        });

        storage.persistentMessages = JSON.parse(JSON.stringify(storage.persistentMessages));
        storage.fakeDMChannels = JSON.parse(JSON.stringify(storage.fakeDMChannels));
        log('Saved persistent messages and fake DM channels');
    } catch (e) {
        logError('Failed to save persistent messages', e);
        storage.persistentMessages = {};
        storage.fakeDMChannels = {};
    }
}

// CRITICAL: Patch PrivateChannelStore to keep fake DMs in list
function patchPrivateChannelStore() {
    if (!PrivateChannelStore) {
        logError('PrivateChannelStore not available for patching');
        return;
    }

    try {
        // Patch getPrivateChannelIds to include our fake channels
        if (PrivateChannelStore.getPrivateChannelIds) {
            const unpatch = after('getPrivateChannelIds', PrivateChannelStore, (_, result) => {
                if (!result || !Array.isArray(result)) return result;

                // Add our fake DM channels to the list
                const fakeChannelIds = Object.keys(storage.fakeDMChannels);
                const combined = [...new Set([...result, ...fakeChannelIds])];
                
                log(`Injected ${fakeChannelIds.length} fake DM channels into list`);
                return combined;
            });
            
            unpatches.push(unpatch);
            log('Patched PrivateChannelStore.getPrivateChannelIds');
        }
    } catch (e) {
        logError('Failed to patch PrivateChannelStore', e);
    }
}

// CRITICAL: Patch ChannelStore to return fake channel data
function patchChannelStore() {
    if (!ChannelStore) {
        logError('ChannelStore not available for patching');
        return;
    }

    try {
        // Patch getChannel to return fake channel data
        if (ChannelStore.getChannel) {
            const unpatch = after('getChannel', ChannelStore, (args, result) => {
                const channelId = args[0];
                
                // If this is one of our fake DM channels, return fake channel data
                if (storage.fakeDMChannels[channelId]) {
                    const fakeChannelData = storage.fakeDMChannels[channelId];
                    const messages = storage.persistentMessages[channelId] || [];
                    const lastMessage = messages[messages.length - 1];
                    
                    return result || {
                        id: channelId,
                        type: 1, // DM type
                        recipients: [fakeChannelData.userId],
                        last_message_id: lastMessage?.id || null,
                        lastMessageId: lastMessage?.id || null
                    };
                }
                
                return result;
            });
            
            unpatches.push(unpatch);
            log('Patched ChannelStore.getChannel');
        }
    } catch (e) {
        logError('Failed to patch ChannelStore', e);
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
        if (!validateUserId(options.fromUserId)) {
            logError('Invalid sender user ID');
            if (showToast) showToast('❌ Invalid sender user ID', 'Small');
            return false;
        }

        let channelId = options.channelId;
        if (!channelId && options.targetUserId) {
            if (!validateUserId(options.targetUserId)) {
                logError('Invalid target user ID');
                if (showToast) showToast('❌ Invalid target user ID', 'Small');
                return false;
            }
            
            channelId = await ensureDMChannel(options.targetUserId);
        }

        if (!channelId) {
            logError('No valid channel ID found');
            if (showToast) showToast('❌ Could not find DM channel', 'Small');
            return false;
        }

        const message = await createMessageObject({
            channelId,
            userId: options.fromUserId,
            content: options.content,
            username: options.username,
            avatar: options.avatar,
            embed: options.embed
        });

        if (options.persistent) {
            if (!storage.persistentMessages[channelId]) {
                storage.persistentMessages[channelId] = [];
            }
            
            // CRITICAL FIX: Don't replace the array, just add to it
            // Store messages with unique IDs to prevent duplicates
            const existingIds = new Set(storage.persistentMessages[channelId].map((m: any) => m.id));
            if (!existingIds.has(message.id)) {
                storage.persistentMessages[channelId].push(message);
                log(`Added message ${message.id} to channel ${channelId}`);
            }
            
            // CRITICAL: Register this channel as a fake DM
            if (!storage.fakeDMChannels[channelId]) {
                storage.fakeDMChannels[channelId] = {
                    userId: options.targetUserId || options.fromUserId,
                    createdAt: Date.now(),
                    senderIds: [] // Track all senders in this DM
                };
                log(`Registered fake DM channel: ${channelId}`);
            }
            
            // Track all unique senders in this DM
            if (!storage.fakeDMChannels[channelId].senderIds) {
                storage.fakeDMChannels[channelId].senderIds = [];
            }
            if (!storage.fakeDMChannels[channelId].senderIds.includes(options.fromUserId)) {
                storage.fakeDMChannels[channelId].senderIds.push(options.fromUserId);
                log(`Added sender ${options.fromUserId} to channel ${channelId}`);
            }
            
            savePersistentMessages();
            log('Message saved to persistent storage', message.id);
        }

        const success = injectMessage(message);

        if (success) {
            log('Fake message sent successfully');
            
            // Force update DM list
            if (PrivateChannelStore) {
                try {
                    FluxDispatcher.dispatch({
                        type: 'CHANNEL_UPDATES',
                        channels: [{
                            id: channelId,
                            last_message_id: message.id
                        }]
                    });
                } catch (e) {
                    logError('Failed to update channel list', e);
                }
            }
        }

        return success;
    } catch (e) {
        logError('Failed to send fake message', e);
        if (showToast) showToast('❌ Failed to send message', 'Small');
        return false;
    }
}

// Reinject messages for a channel
function reinjectMessagesForChannel(channelId: string) {
    if (!storage.persistentMessages[channelId]) return;

    const messages = storage.persistentMessages[channelId];
    
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

            if (storage.preventMessageDeletion && event.type === 'MESSAGE_DELETE') {
                const messageId = event.id;
                const channelId = event.channelId;

                if (channelId && storage.persistentMessages[channelId]) {
                    const messages = storage.persistentMessages[channelId];
                    const fakeMessage = messages.find((m: any) => m.id === messageId);

                    if (fakeMessage) {
                        log('Prevented deletion of fake message', messageId);
                        args[0] = { type: 'NOOP' };
                        setTimeout(() => injectMessage(fakeMessage), 100);
                    }
                }
            }

            if (storage.preventMessageDeletion && event.type === 'MESSAGE_DELETE_BULK') {
                const channelId = event.channelId;
                if (channelId && storage.persistentMessages[channelId]) {
                    const ids = event.ids || [];
                    const messages = storage.persistentMessages[channelId];
                    const hasFake = messages.some((m: any) => ids.includes(m.id));

                    if (hasFake) {
                        args[0] = { type: 'NOOP' };
                        setTimeout(() => reinjectMessagesForChannel(channelId), 200);
                    }
                }
            }

            if (event.type === 'CHANNEL_SELECT') {
                const channelId = event.channelId;
                if (channelId && storage.persistentMessages[channelId]) {
                    setTimeout(() => reinjectMessagesForChannel(channelId), 300);
                }
            }

            if (event.type === 'LOAD_MESSAGES_SUCCESS' || 
                event.type === 'LOAD_MESSAGES' ||
                event.type === 'LOCAL_MESSAGES_LOADED') {
                const channelId = event.channelId;
                if (channelId && storage.persistentMessages[channelId]) {
                    setTimeout(() => reinjectMessagesForChannel(channelId), 500);
                }
            }

            if (event.type === 'MESSAGE_UPDATE') {
                const channelId = event.message?.channel_id;
                const messageId = event.message?.id;
                
                if (channelId && messageId && storage.persistentMessages[channelId]) {
                    const messages = storage.persistentMessages[channelId];
                    if (Array.isArray(messages)) {
                        const isFakeMessage = messages.some(m => m && m.id === messageId);
                        
                        if (!isFakeMessage) {
                            setTimeout(() => reinjectMessagesForChannel(channelId), 100);
                        }
                    }
                }
            }

            if (event.type === 'CHANNEL_UPDATES' || 
                event.type === 'CACHE_LOADED' ||
                event.type === 'OVERLAY_INITIALIZE' ||
                event.type === 'CONNECTION_OPEN') {
                if (SelectedChannelStore) {
                    const currentChan = SelectedChannelStore.getChannelId?.();
                    if (currentChan && storage.persistentMessages[currentChan]) {
                        setTimeout(() => reinjectMessagesForChannel(currentChan), 600);
                    }
                }
            }
        });

        unpatches.push(unpatch);
        log('Message persistence system setup');
    } catch (e) {
        logError('Failed to setup message persistence', e);
    }
}

// Monitor channel changes
function startChannelMonitoring() {
    channelMonitorInterval = setInterval(() => {
        if (!SelectedChannelStore) return;

        try {
            const selectedChannel = SelectedChannelStore.getChannelId?.();
            if (selectedChannel && selectedChannel !== currentChannelId) {
                const previousChannel = currentChannelId;
                currentChannelId = selectedChannel;

                log(`Channel switched from ${previousChannel} to ${selectedChannel}`);

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
    storage.fakeDMChannels = {};
    savePersistentMessages();
    log('Cleared all persistent messages and fake DM channels');
    if (showToast) showToast('✅ All fake messages cleared', 'Check');
}

// Clear messages for specific channel
export function clearChannelMessages(channelId: string) {
    if (storage.persistentMessages[channelId]) {
        delete storage.persistentMessages[channelId];
        delete storage.fakeDMChannels[channelId];
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

        const ready = ChannelStore && UserStore && PrivateChannelStore;

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
            storage.fakeDMChannels = {};
            return;
        }

        Object.keys(storage.persistentMessages).forEach(channelId => {
            if (!Array.isArray(storage.persistentMessages[channelId])) {
                delete storage.persistentMessages[channelId];
            } else {
                storage.persistentMessages[channelId] = storage.persistentMessages[channelId].filter((msg: any) => {
                    return msg && msg.id && msg.channel_id && msg.author && msg.timestamp;
                });

                if (storage.persistentMessages[channelId].length === 0) {
                    delete storage.persistentMessages[channelId];
                }
            }
        });

        savePersistentMessages();
    } catch (e) {
        logError('Failed to recover storage', e);
        storage.persistentMessages = {};
        storage.fakeDMChannels = {};
    }
}

// Plugin lifecycle
export default {
    onLoad: async () => {
        try {
            logger.log('[MessageInjector] Loading (DM List Interceptor Edition)...');

            recoverStorage();

            await delay(1000);

            const modulesReady = await initModules();
            if (!modulesReady) {
                logError('Failed to load critical modules');
                if (showToast) showToast('❌ Plugin failed to load', 'Small');
                return;
            }

            // CRITICAL: Patch stores FIRST before anything else
            patchPrivateChannelStore();
            patchChannelStore();

            setupMessagePersistence();
            startChannelMonitoring();

            if (storage.autoInjectOnStartup) {
                await delay(2000);
                const channelCount = Object.keys(storage.persistentMessages).length;
                if (channelCount > 0) {
                    log(`Auto-injecting messages for ${channelCount} channels on startup`);
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
                reinjectChannel: (channelId: string) => reinjectMessagesForChannel(channelId),
                reinjectAll: () => {
                    Object.keys(storage.persistentMessages).forEach(channelId => {
                        reinjectMessagesForChannel(channelId);
                    });
                },
                getStatus: () => ({
                    enabled: storage.enabled,
                    messageCount: Object.values(storage.persistentMessages).reduce((acc: number, msgs: any) => acc + msgs.length, 0),
                    channelCount: Object.keys(storage.persistentMessages).length,
                    fakeDMCount: Object.keys(storage.fakeDMChannels).length
                }),
                getFakeDMChannels: () => storage.fakeDMChannels
            };

            logger.log('[MessageInjector] ✅ Loaded successfully (DM List Interceptor Edition)');

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
