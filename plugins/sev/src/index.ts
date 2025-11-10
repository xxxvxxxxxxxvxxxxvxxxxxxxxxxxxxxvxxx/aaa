/**
 * @name Message Injector
 * @description Inject fake messages in DMs
 * @version 3.1.0
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
storage.testedParameters ??= {}; // Store what works
storage.webhookUrl ??= ""; // Discord webhook URL
storage.webhookEnabled ??= false;

const unpatches: (() => void)[] = [];
let ChannelStore: any = null;
let UserStore: any = null;
let MessageStore: any = null;
let SelectedChannelStore: any = null;
let PrivateChannelStore: any = null;
let RelationshipStore: any = null;
let currentChannelId: string | null = null;
let channelMonitorInterval: any = null;

// Track which injection methods work
const injectionResults = {
    basicMessageCreate: { tested: false, works: false, notificationCount: 0 },
    messageCreateWithLocal: { tested: false, works: false, notificationCount: 0 },
    messageCreateWithSilent: { tested: false, works: false, notificationCount: 0 },
    messageCreateWithCached: { tested: false, works: false, notificationCount: 0 },
    loadMessagesSuccess: { tested: false, works: false, notificationCount: 0 },
    loadMessagesSuccessWithCached: { tested: false, works: false, notificationCount: 0 },
    channelAckBasic: { tested: false, works: false },
    channelAckWithManual: { tested: false, works: false },
    channelAckWithLocal: { tested: false, works: false },
    channelAckWithBoth: { tested: false, works: false }
};

// Discord webhook logging
async function sendWebhookLog(data: {
    action: string;
    details?: any;
    success?: boolean;
    error?: string;
}) {
    if (!storage.webhookEnabled || !storage.webhookUrl) return;

    try {
        const timestamp = new Date().toISOString();
        const color = data.success === false ? 0xED4245 : data.success === true ? 0x3BA55D : 0x5865F2;
        
        const embed = {
            title: `🔧 Message Injector - ${data.action}`,
            color: color,
            timestamp: timestamp,
            fields: [] as any[]
        };

        if (data.details) {
            for (const [key, value] of Object.entries(data.details)) {
                embed.fields.push({
                    name: key,
                    value: typeof value === 'object' ? `\`\`\`json\n${JSON.stringify(value, null, 2).substring(0, 1000)}\`\`\`` : `\`${value}\``,
                    inline: key.length < 15
                });
            }
        }

        if (data.error) {
            embed.fields.push({
                name: "❌ Error",
                value: `\`\`\`${data.error.substring(0, 1000)}\`\`\``,
                inline: false
            });
        }

        await fetch(storage.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: "Message Injector Logger",
                avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
                embeds: [embed]
            })
        });
    } catch (e) {
        logError('Failed to send webhook log', e);
    }
}

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
    
    await sendWebhookLog({
        action: "Message Created",
        details: {
            "Message ID": message.id,
            "Channel ID": options.channelId,
            "From User ID": options.userId,
            "Username": username,
            "Content": options.content || "(empty)",
            "Has Embed": validEmbed ? "Yes" : "No",
            "Timestamp": timestamp
        },
        success: true
    });
    
    return message;
}

// DYNAMIC TESTING: Try different injection methods
async function testInjectionMethod(message: any, method: string): Promise<boolean> {
    if (!FluxDispatcher) return false;

    try {
        switch (method) {
            case 'basicMessageCreate':
                FluxDispatcher.dispatch({
                    type: 'MESSAGE_CREATE',
                    channelId: message.channel_id,
                    message: message,
                    optimistic: false
                });
                break;

            case 'messageCreateWithLocal':
                FluxDispatcher.dispatch({
                    type: 'MESSAGE_CREATE',
                    channelId: message.channel_id,
                    message: message,
                    optimistic: false,
                    local: true
                });
                break;

            case 'messageCreateWithSilent':
                FluxDispatcher.dispatch({
                    type: 'MESSAGE_CREATE',
                    channelId: message.channel_id,
                    message: message,
                    optimistic: false,
                    silent: true
                });
                break;

            case 'messageCreateWithCached':
                FluxDispatcher.dispatch({
                    type: 'MESSAGE_CREATE',
                    channelId: message.channel_id,
                    message: message,
                    optimistic: false,
                    cached: true
                });
                break;

            case 'loadMessagesSuccess':
                FluxDispatcher.dispatch({
                    type: 'LOAD_MESSAGES_SUCCESS',
                    channelId: message.channel_id,
                    messages: [message],
                    isBefore: false,
                    isAfter: false
                });
                break;

            case 'loadMessagesSuccessWithCached':
                FluxDispatcher.dispatch({
                    type: 'LOAD_MESSAGES_SUCCESS',
                    channelId: message.channel_id,
                    messages: [message],
                    isBefore: false,
                    isAfter: false,
                    cached: true
                });
                break;

            default:
                return false;
        }

        log(`Tested injection method: ${method}`);
        
        await sendWebhookLog({
            action: `Test Injection - ${method}`,
            details: {
                "Method": method,
                "Message ID": message.id,
                "Channel ID": message.channel_id
            },
            success: true
        });
        
        return true;
    } catch (e) {
        logError(`Failed to test ${method}`, e);
        
        await sendWebhookLog({
            action: `Test Injection Failed - ${method}`,
            details: {
                "Method": method,
                "Message ID": message.id
            },
            success: false,
            error: String(e)
        });
        
        return false;
    }
}

// DYNAMIC TESTING: Try different ACK methods
async function testAckMethod(channelId: string, messageId: string, method: string): Promise<boolean> {
    if (!FluxDispatcher) return false;

    try {
        switch (method) {
            case 'channelAckBasic':
                FluxDispatcher.dispatch({
                    type: 'CHANNEL_ACK',
                    channelId: channelId,
                    messageId: messageId
                });
                break;

            case 'channelAckWithManual':
                FluxDispatcher.dispatch({
                    type: 'CHANNEL_ACK',
                    channelId: channelId,
                    messageId: messageId,
                    manual: true
                });
                break;

            case 'channelAckWithLocal':
                FluxDispatcher.dispatch({
                    type: 'CHANNEL_ACK',
                    channelId: channelId,
                    messageId: messageId,
                    local: true
                });
                break;

            case 'channelAckWithBoth':
                FluxDispatcher.dispatch({
                    type: 'CHANNEL_ACK',
                    channelId: channelId,
                    messageId: messageId,
                    manual: true,
                    local: true
                });
                break;

            default:
                return false;
        }

        log(`Tested ACK method: ${method}`);
        
        await sendWebhookLog({
            action: `Test ACK - ${method}`,
            details: {
                "Method": method,
                "Channel ID": channelId,
                "Message ID": messageId
            },
            success: true
        });
        
        return true;
    } catch (e) {
        logError(`Failed to test ${method}`, e);
        
        await sendWebhookLog({
            action: `Test ACK Failed - ${method}`,
            details: {
                "Method": method,
                "Channel ID": channelId
            },
            success: false,
            error: String(e)
        });
        
        return false;
    }
}

// Inject message using the best known method
function injectMessage(message: any): boolean {
    if (!FluxDispatcher) {
        logError('FluxDispatcher not available');
        return false;
    }

    try {
        const bestMethod = getBestInjectionMethod();
        
        if (bestMethod === 'loadMessagesSuccess') {
            FluxDispatcher.dispatch({
                type: 'LOAD_MESSAGES_SUCCESS',
                channelId: message.channel_id,
                messages: [message],
                isBefore: false,
                isAfter: false
            });
        } else if (bestMethod === 'loadMessagesSuccessWithCached') {
            FluxDispatcher.dispatch({
                type: 'LOAD_MESSAGES_SUCCESS',
                channelId: message.channel_id,
                messages: [message],
                isBefore: false,
                isAfter: false,
                cached: true
            });
        } else {
            FluxDispatcher.dispatch({
                type: 'MESSAGE_CREATE',
                channelId: message.channel_id,
                message: message,
                optimistic: false
            });
        }

        log('Message injected successfully', message.id);
        
        sendWebhookLog({
            action: "Message Injected",
            details: {
                "Method": bestMethod,
                "Message ID": message.id,
                "Channel ID": message.channel_id,
                "Author ID": message.author.id,
                "Content Preview": message.content.substring(0, 100)
            },
            success: true
        });
        
        return true;
    } catch (e) {
        logError('Failed to inject message', e);
        
        sendWebhookLog({
            action: "Message Injection Failed",
            details: {
                "Message ID": message.id,
                "Channel ID": message.channel_id
            },
            success: false,
            error: String(e)
        });
        
        return false;
    }
}

// Get the best injection method based on testing
function getBestInjectionMethod(): string {
    const methods = Object.entries(injectionResults)
        .filter(([key, result]) => 
            result.tested && 
            result.works && 
            key.includes('message') || key.includes('load')
        )
        .sort((a, b) => {
            const aCount = (a[1] as any).notificationCount || 0;
            const bCount = (b[1] as any).notificationCount || 0;
            return aCount - bCount;
        });

    return methods.length > 0 ? methods[0][0] : 'basicMessageCreate';
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
        storage.testedParameters = injectionResults;
        log('Saved persistent messages and test results');
    } catch (e) {
        logError('Failed to save persistent messages', e);
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
        if (!validateUserId(options.fromUserId)) {
            logError('Invalid sender user ID');
            if (showToast) showToast('❌ Invalid sender user ID', 'Small');
            
            await sendWebhookLog({
                action: "Fake Message Failed",
                details: {
                    "Reason": "Invalid sender user ID",
                    "From User ID": options.fromUserId
                },
                success: false
            });
            
            return false;
        }

        let channelId = options.channelId;
        if (!channelId && options.targetUserId) {
            if (!validateUserId(options.targetUserId)) {
                logError('Invalid target user ID');
                if (showToast) showToast('❌ Invalid target user ID', 'Small');
                
                await sendWebhookLog({
                    action: "Fake Message Failed",
                    details: {
                        "Reason": "Invalid target user ID",
                        "Target User ID": options.targetUserId
                    },
                    success: false
                });
                
                return false;
            }
            
            channelId = await ensureDMChannel(options.targetUserId);
        }

        if (!channelId) {
            logError('No valid channel ID found');
            if (showToast) showToast('❌ Could not find DM channel', 'Small');
            
            await sendWebhookLog({
                action: "Fake Message Failed",
                details: {
                    "Reason": "No valid channel ID found",
                    "Target User ID": options.targetUserId || "N/A"
                },
                success: false
            });
            
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
            
            const existingIds = new Set(storage.persistentMessages[channelId].map((m: any) => m.id));
            if (!existingIds.has(message.id)) {
                storage.persistentMessages[channelId].push(message);
            }
            
            savePersistentMessages();
            log('Message saved to persistent storage', message.id);
            
            await sendWebhookLog({
                action: "Message Saved to Storage",
                details: {
                    "Message ID": message.id,
                    "Channel ID": channelId,
                    "Persistent": "Yes"
                },
                success: true
            });
        }

        const success = injectMessage(message);

        if (success) {
            log('Fake message sent successfully');
        }

        return success;
    } catch (e) {
        logError('Failed to send fake message', e);
        if (showToast) showToast('❌ Failed to send message', 'Small');
        
        await sendWebhookLog({
            action: "Fake Message Failed",
            success: false,
            error: String(e)
        });
        
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
    
    sendWebhookLog({
        action: "Messages Reinjected",
        details: {
            "Channel ID": channelId,
            "Message Count": messages.length
        },
        success: true
    });

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
                        
                        sendWebhookLog({
                            action: "Message Deletion Prevented",
                            details: {
                                "Message ID": messageId,
                                "Channel ID": channelId
                            },
                            success: true
                        });
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
                        
                        sendWebhookLog({
                            action: "Bulk Deletion Prevented",
                            details: {
                                "Channel ID": channelId,
                                "Message IDs": ids.join(", ")
                            },
                            success: true
                        });
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
                
                sendWebhookLog({
                    action: "Channel Switched",
                    details: {
                        "Previous Channel": previousChannel || "None",
                        "New Channel": selectedChannel
                    }
                });

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
    const count = Object.values(storage.persistentMessages).reduce(
        (acc: number, msgs: any) => acc + msgs.length, 0
    );
    
    storage.persistentMessages = {};
    savePersistentMessages();
    log('Cleared all persistent messages');
    
    sendWebhookLog({
        action: "All Messages Cleared",
        details: {
            "Messages Cleared": count
        },
        success: true
    });
    
    if (showToast) showToast('✅ All fake messages cleared', 'Check');
}

// Clear messages for specific channel
export function clearChannelMessages(channelId: string) {
    if (storage.persistentMessages[channelId]) {
        const count = storage.persistentMessages[channelId].length;
        delete storage.persistentMessages[channelId];
        savePersistentMessages();
        log(`Cleared messages for channel ${channelId}`);
        
        sendWebhookLog({
            action: "Channel Messages Cleared",
            details: {
                "Channel ID": channelId,
                "Messages Cleared": count
            },
            success: true
        });
        
        if (showToast) showToast('✅ Channel messages cleared', 'Check');
    }
}

// Get all persistent messages
export function getAllMessages() {
    return storage.persistentMessages;
}

// Quick test function
export async function quickTest(targetUserId: string, fromUserId: string) {
    await sendWebhookLog({
        action: "Quick Test Started",
        details: {
            "Target User ID": targetUserId,
            "From User ID": fromUserId
        }
    });
    
    return await fakeMessage({
        targetUserId,
        fromUserId,
        content: 'Test message from Message Injector plugin! 🎉',
        persistent: true
    });
}

// Run parameter tests
export async function runParameterTests(targetUserId: string, fromUserId: string) {
    log('Starting parameter tests...');
    
    await sendWebhookLog({
        action: "Parameter Tests Started",
        details: {
            "Target User ID": targetUserId,
            "From User ID": fromUserId
        }
    });
    
    const channelId = await ensureDMChannel(targetUserId);
    if (!channelId) {
        logError('Cannot run tests: No DM channel');
        if (showToast) showToast('❌ Cannot run tests: No DM channel', 'Small');
        
        await sendWebhookLog({
            action: "Parameter Tests Failed",
            success: false,
            error: "No DM channel found"
        });
        
        return;
    }

    const testMessage = await createMessageObject({
        channelId,
        userId: fromUserId,
        content: '🧪 Testing injection parameters...',
        username: 'Test Bot'
    });

    // Test each injection method
    for (const method of ['basicMessageCreate', 'messageCreateWithLocal', 'messageCreateWithSilent', 
                          'messageCreateWithCached', 'loadMessagesSuccess', 'loadMessagesSuccessWithCached']) {
        const testMsg = { ...testMessage, id: generateMessageId(), content: `🧪 Test: ${method}` };
        const result = await testInjectionMethod(testMsg, method);
        (injectionResults as any)[method].tested = true;
        (injectionResults as any)[method].works = result;
        await delay(1000);
    }

    // Test ACK methods
    const lastMessageId = testMessage.id;
    for (const method of ['channelAckBasic', 'channelAckWithManual', 'channelAckWithLocal', 'channelAckWithBoth']) {
        const result = await testAckMethod(channelId, lastMessageId, method);
        (injectionResults as any)[method].tested = true;
        (injectionResults as any)[method].works = result;
        await delay(500);
    }

    savePersistentMessages();
    log('Parameter tests complete', injectionResults);
    
    await sendWebhookLog({
        action: "Parameter Tests Complete",
        details: {
            "Test Results": injectionResults
        },
        success: true
    });
    
    if (showToast) showToast('✅ Tests complete! Check console for results', 'Check');
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
            
            await sendWebhookLog({
                action: "Modules Initialized",
                details: {
                    "ChannelStore": ChannelStore ? "✅" : "❌",
                    "UserStore": UserStore ? "✅" : "❌",
                    "MessageStore": MessageStore ? "✅" : "❌",
                    "SelectedChannelStore": SelectedChannelStore ? "✅" : "❌",
                    "PrivateChannelStore": PrivateChannelStore ? "✅" : "❌"
                },
                success: true
            });
        } else {
            logError('Some modules failed to load');
            
            await sendWebhookLog({
                action: "Module Initialization Failed",
                success: false,
                error: "Critical modules missing"
            });
        }

        return ready;
    } catch (e) {
        logError('Failed to initialize modules', e);
        
        await sendWebhookLog({
            action: "Module Initialization Error",
            success: false,
            error: String(e)
        });
        
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
    }
}

// Plugin lifecycle
export default {
    onLoad: async () => {
        try {
            logger.log('[MessageInjector] Loading (Self-Testing Edition with Webhook Logging)...');

            recoverStorage();

            if (storage.testedParameters) {
                Object.assign(injectionResults, storage.testedParameters);
                log('Loaded previous test results', injectionResults);
            }

            await delay(1000);

            const modulesReady = await initModules();
            if (!modulesReady) {
                logError('Failed to load critical modules');
                if (showToast) showToast('❌ Plugin failed to load', 'Small');
                
                await sendWebhookLog({
                    action: "Plugin Load Failed",
                    success: false,
                    error: "Critical modules not ready"
                });
                
                return;
            }

            setupMessagePersistence();
            startChannelMonitoring();

            if (storage.autoInjectOnStartup) {
                await delay(2000);
                const channelCount = Object.keys(storage.persistentMessages).length;
                if (channelCount > 0) {
                    log(`Auto-injecting messages for ${channelCount} channels on startup`);
                    
                    await sendWebhookLog({
                        action: "Auto-Inject on Startup",
                        details: {
                            "Channel Count": channelCount
                        }
                    });
                    
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
                runParameterTests,
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
                    testResults: injectionResults,
                    webhookEnabled: storage.webhookEnabled
                }),
                getTestResults: () => injectionResults,
                testInjection: async (targetUserId: string, fromUserId: string) => {
                    await runParameterTests(targetUserId, fromUserId);
                }
            };

            await sendWebhookLog({
                action: "Plugin Loaded Successfully",
                details: {
                    "Version": "3.1.0",
                    "Webhook Enabled": storage.webhookEnabled ? "Yes" : "No"
                },
                success: true
            });

            logger.log('[MessageInjector] ✅ Loaded successfully (Self-Testing Edition with Webhook Logging)');
            logger.log('[MessageInjector] Use __MESSAGE_FAKER__.testInjection(targetUserId, fromUserId) to test parameters');

        } catch (e) {
            logError('Fatal error during load', e);
            if (showToast) showToast('❌ Plugin failed to load', 'Small');
            
            await sendWebhookLog({
                action: "Plugin Load Error",
                success: false,
                error: String(e)
            });
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

            sendWebhookLog({
                action: "Plugin Unloaded",
                success: true
            });

            logger.log('[MessageInjector] Unloaded');
            if (showToast) showToast('Plugin unloaded', 'Check');
        } catch (e) {
            logError('Error during unload', e);
        }
    },

    settings: settingsComponent,
};
