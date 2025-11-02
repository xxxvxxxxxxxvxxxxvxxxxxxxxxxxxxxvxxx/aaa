/**
 * @name Injector
 * @description Inject fake messages in DMs from anyone
 * @version 1.0.0
 */
import settingsComponent from "./settings";

// Extend Window interface for Bunny/Vendetta
declare global {
    interface Window {
        bunny: any;
        vendetta: any;
    }
}

// Detect which mod we're running on
const isBunny = typeof window.bunny !== 'undefined';
const isVendetta = typeof window.vendetta !== 'undefined';
const API = isBunny ? window.bunny : window.vendetta;

const { findByProps, findByStoreName } = API.metro;
const { after, before } = API.patcher;
const { storage } = API.plugin;
const { showToast } = API.ui?.toasts || { showToast: console.log };

// Initialize storage
storage.enabled ??= true;
storage.debug ??= false;
storage.persistentMessages ??= {};
storage.autoInjectOnStartup ??= true;
storage.preventMessageDeletion ??= true;

const unpatches: (() => void)[] = [];
let FluxDispatcher: any = null;
let ChannelStore: any = null;
let UserStore: any = null;
let MessageStore: any = null;
let SelectedChannelStore: any = null;
let currentChannelId: string | null = null;

// Logging
const log = (msg: string, data?: any) => {
    if (storage.debug) {
        console.log(`[MessageInjector] ${msg}`, data || '');
    }
};

const logError = (msg: string, err?: any) => {
    console.error(`[MessageInjector] ${msg}`, err || '');
};

// Delay helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

// Get user info (username, avatar) from user ID
async function getUserInfo(userId: string): Promise<{ username: string; avatar: string | null; discriminator: string }> {
    try {
        if (UserStore) {
            const user = UserStore.getUser?.(userId);
            if (user) {
                return {
                    username: user.username || 'Unknown User',
                    discriminator: user.discriminator || '0',
                    avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png` : null
                };
            }
        }
    } catch (e) {
        logError('Failed to get user info', e);
    }

    return {
        username: 'Unknown User',
        discriminator: '0',
        avatar: null
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

// Generate unique message ID
function generateMessageId(): string {
    return `${Date.now()}${Math.random().toString(36).substring(2, 11)}`;
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

    let username = options.username;
    let avatar = options.avatar;

    // If username not provided, fetch from UserStore
    if (!username) {
        const userInfo = await getUserInfo(options.userId);
        username = userInfo.username;
        if (!avatar) avatar = userInfo.avatar;
    }

    const message = {
        id: options.messageId || generateMessageId(),
        channel_id: options.channelId,
        author: {
            id: options.userId,
            username: username || 'Unknown User',
            discriminator: '0',
            avatar: avatar || undefined,
            bot: false,
            public_flags: 0
        },
        content: options.content || '',
        timestamp: options.timestamp || new Date().toISOString(),
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: options.embed ? [options.embed] : [],
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

// Save persistent messages to storage
function savePersistentMessages() {
    try {
        storage.persistentMessages = JSON.parse(JSON.stringify(storage.persistentMessages));
        log('Saved persistent messages', Object.keys(storage.persistentMessages).length);
    } catch (e) {
        logError('Failed to save persistent messages', e);
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
        // Get channel ID
        let channelId = options.channelId;
        if (!channelId && options.targetUserId) {
            channelId = getDMChannelId(options.targetUserId);
        }

        if (!channelId) {
            logError('No valid channel ID found');
            if (showToast) showToast('Failed: Could not find DM channel', 'Small');
            return false;
        }

        // Create message
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
        }

        return success;
    } catch (e) {
        logError('Failed to send fake message', e);
        if (showToast) showToast('Failed to send fake message', 'Small');
        return false;
    }
}

// Reinject all messages for a specific channel
function reinjectMessagesForChannel(channelId: string) {
    if (!storage.persistentMessages[channelId]) return;

    const messages = storage.persistentMessages[channelId];
    log(`Reinjecting ${messages.length} messages for channel ${channelId}`);

    messages.forEach((message: any, index: number) => {
        setTimeout(() => {
            injectMessage(message);
        }, index * 50);
    });
}

// Setup message persistence
function setupMessagePersistence() {
    try {
        if (!FluxDispatcher) return;

        unpatches.push(
            before('dispatch', FluxDispatcher, (args: any[]) => {
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

                // Reinject on message load - MULTIPLE ATTEMPTS
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
                    event.type === 'CHANNEL_UPDATES') {
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
            })
        );

        log('Message persistence system setup with comprehensive event coverage');
    } catch (e) {
        logError('Failed to setup message persistence', e);
    }
}

// Monitor channel changes and reinject messages
function startChannelMonitoring() {
    // Fast interval for immediate response
    setInterval(() => {
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
    setInterval(() => {
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
    if (showToast) showToast('All fake messages cleared', 'Check');
}

// Clear messages for specific channel
export function clearChannelMessages(channelId: string) {
    if (storage.persistentMessages[channelId]) {
        delete storage.persistentMessages[channelId];
        savePersistentMessages();
        log(`Cleared messages for channel ${channelId}`);
        if (showToast) showToast('Channel messages cleared', 'Check');
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
        content: 'Test message from Message Injector plugin!',
        persistent: true
    });
}

// Initialize modules
async function initModules() {
    try {
        FluxDispatcher = findStore(['FluxDispatcher', 'Dispatcher'], ['dispatch', 'subscribe']);
        ChannelStore = findStore(['ChannelStore'], ['getChannel', 'getDMFromUserId']);
        UserStore = findStore(['UserStore', 'CurrentUserStore'], ['getUser', 'getCurrentUser']);
        MessageStore = findStore(['MessageStore'], ['getMessages', 'getMessage']);
        SelectedChannelStore = findStore(['SelectedChannelStore'], ['getChannelId']);

        const ready = FluxDispatcher && ChannelStore && UserStore;

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

// Initialize the plugin immediately
(async () => {
    try {
        console.log('[MessageInjector] Loading...');

        await delay(1000);

        const modulesReady = await initModules();
        if (!modulesReady) {
            logError('Failed to load critical modules');
            if (showToast) showToast('Plugin failed to load', 'Small');
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

        console.log('[MessageInjector] Loaded successfully');
        if (showToast) showToast('Message Injector loaded!', 'Check');

    } catch (e) {
        logError('Fatal error during load', e);
        if (showToast) showToast('Plugin failed to load', 'Small');
    }
})();

export const onLoad = () => { };

// Cleanup function for when plugin is unloaded
export const onUnload = () => {
    try {
        for (const unpatch of unpatches) {
            try {
                unpatch();
            } catch (e) { }
        }

        unpatches.length = 0;

        if ((window as any).__MESSAGE_FAKER__) {
            delete (window as any).__MESSAGE_FAKER__;
        }

        console.log('[MessageInjector] Unloaded');
        if (showToast) showToast('Plugin unloaded', 'Check');
    } catch (e) {
        logError('Error during unload', e);
    }
};

// Export separately so they can be referenced individually if needed
export { settingsComponent as settings };

// Export the lifecycle object expected by Vendetta/Kettu
export default {
    onLoad,
    onUnload,
    settings: settingsComponent,
};
