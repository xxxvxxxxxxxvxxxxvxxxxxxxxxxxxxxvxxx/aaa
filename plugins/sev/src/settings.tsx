import { React, ReactNative as RN, clipboard } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { useProxy } from "@vendetta/storage";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";

const { FormInput, FormSwitch, FormSection, FormDivider, FormRow, FormText } = Forms;
const { View, Text, ScrollView, TouchableOpacity, StyleSheet } = RN;

const styles = StyleSheet.create({
    button: {
        backgroundColor: "#5865F2",
        padding: 12,
        borderRadius: 8,
        alignItems: "center" as const,
        marginVertical: 8,
        marginHorizontal: 16,
    },
    successButton: {
        backgroundColor: "#3BA55D",
    },
    dangerButton: {
        backgroundColor: "#ED4245",
    },
    warningButton: {
        backgroundColor: "#FAA61A",
    },
    infoButton: {
        backgroundColor: "#4F545C",
    },
    buttonText: {
        color: "white",
        fontWeight: "bold" as const,
        fontSize: 16,
    },
    infoText: {
        color: "#B9BBBE",
        fontSize: 14,
        marginHorizontal: 16,
        marginVertical: 8,
    },
    warningText: {
        color: "#FAA61A",
        fontSize: 13,
        marginHorizontal: 16,
        marginVertical: 4,
    },
    successText: {
        color: "#3BA55D",
        fontSize: 13,
        marginHorizontal: 16,
        marginVertical: 4,
    },
    codeText: {
        fontFamily: "monospace",
        backgroundColor: "#2F3136",
        padding: 8,
        borderRadius: 4,
        marginHorizontal: 16,
        marginVertical: 4,
        color: "#DCDDDE",
    },
});

// Helper to safely access the API
function getAPI() {
    return (window as any).__MESSAGE_FAKER__;
}

export default () => {
    useProxy(storage);

    const [targetUserId, setTargetUserId] = React.useState("");
    const [fromUserId, setFromUserId] = React.useState("");
    const [messageContent, setMessageContent] = React.useState("");
    const [messageTimestamp, setMessageTimestamp] = React.useState("");
    
    // NEW: URL auto-embed
    const [embedUrl, setEmbedUrl] = React.useState("");
    
    // Manual embed fields (optional)
    const [embedTitle, setEmbedTitle] = React.useState("");
    const [embedDescription, setEmbedDescription] = React.useState("");
    const [embedColor, setEmbedColor] = React.useState("");
    const [embedImage, setEmbedImage] = React.useState("");
    const [embedThumbnail, setEmbedThumbnail] = React.useState("");
    const [embedAuthorName, setEmbedAuthorName] = React.useState("");
    const [embedAuthorUrl, setEmbedAuthorUrl] = React.useState("");
    const [embedAuthorIcon, setEmbedAuthorIcon] = React.useState("");
    const [embedFooterText, setEmbedFooterText] = React.useState("");
    const [embedFooterIcon, setEmbedFooterIcon] = React.useState("");
    const [embedTimestamp, setEmbedTimestamp] = React.useState("");
    const [embedFields, setEmbedFields] = React.useState("");

    const handleSendFakeMessage = async () => {
        const api = getAPI();
        if (!api) {
            showToast("❌ Plugin not ready", "Small");
            return;
        }

        if (!targetUserId.trim()) {
            showToast("❌ Enter target user ID", "Small");
            return;
        }

        if (!fromUserId.trim()) {
            showToast("❌ Enter sender user ID", "Small");
            return;
        }

        if (!messageContent.trim() && !embedTitle.trim() && !embedUrl.trim()) {
            showToast("❌ Enter message content, embed URL, or manual embed", "Small");
            return;
        }

        // Build manual embed object with all fields (if provided)
        let embed = undefined;
        if (embedTitle || embedDescription || embedImage || embedThumbnail || 
            embedAuthorName || embedFooterText || embedColor || 
            embedTimestamp || embedFields) {
            
            embed = {};
            
            if (embedTitle) embed.title = embedTitle;
            if (embedDescription) embed.description = embedDescription;
            
            // Parse color (hex or decimal)
            if (embedColor) {
                const colorStr = embedColor.trim();
                if (colorStr.startsWith('#')) {
                    embed.color = parseInt(colorStr.substring(1), 16);
                } else if (colorStr.startsWith('0x')) {
                    embed.color = parseInt(colorStr, 16);
                } else if (!isNaN(Number(colorStr))) {
                    embed.color = Number(colorStr);
                }
            }
            
            if (embedImage) embed.image = { url: embedImage };
            if (embedThumbnail) embed.thumbnail = { url: embedThumbnail };
            
            if (embedAuthorName) {
                embed.author = { name: embedAuthorName };
                if (embedAuthorUrl) embed.author.url = embedAuthorUrl;
                if (embedAuthorIcon) embed.author.icon_url = embedAuthorIcon;
            }
            
            if (embedFooterText) {
                embed.footer = { text: embedFooterText };
                if (embedFooterIcon) embed.footer.icon_url = embedFooterIcon;
            }
            
            if (embedTimestamp) embed.timestamp = embedTimestamp;
            
            // Parse fields (JSON array format)
            if (embedFields) {
                try {
                    const parsedFields = JSON.parse(embedFields);
                    if (Array.isArray(parsedFields)) {
                        embed.fields = parsedFields;
                    }
                } catch (e) {
                    showToast("⚠️ Invalid fields JSON format", "Small");
                }
            }
        }

        try {
            const success = await api.fakeMessage({
                targetUserId: targetUserId.trim(),
                fromUserId: fromUserId.trim(),
                content: messageContent.trim(),
                embed: embed,
                embedUrl: embedUrl.trim() || undefined, // NEW: Pass URL for auto-embed
                timestamp: messageTimestamp.trim() || undefined,
                persistent: true
            });

            if (success) {
                showToast("✅ Fake message sent!", "Check");
            }
        } catch (e) {
            showToast("❌ Failed to send message", "Small");
        }
    };

    const handleTestUrlEmbed = async () => {
        const api = getAPI();
        if (!api) {
            showToast("❌ Plugin not ready", "Small");
            return;
        }

        if (!embedUrl.trim()) {
            showToast("❌ Enter a URL first", "Small");
            return;
        }

        try {
            showToast("🔍 Fetching embed data...", "Small");
            const embedData = await api.fetchOpenGraphData(embedUrl.trim());
            
            if (embedData) {
                // Auto-fill the manual embed fields with fetched data
                if (embedData.title) setEmbedTitle(embedData.title);
                if (embedData.description) setEmbedDescription(embedData.description);
                if (embedData.color) setEmbedColor(embedData.color.toString());
                if (embedData.image?.url) setEmbedImage(embedData.image.url);
                if (embedData.author?.name) setEmbedAuthorName(embedData.author.name);
                if (embedData.author?.icon_url) setEmbedAuthorIcon(embedData.author.icon_url);
                
                showToast("✅ Embed data loaded! Review and edit below", "Check");
            } else {
                showToast("❌ Could not fetch embed data from URL", "Small");
            }
        } catch (e) {
            showToast("❌ Failed to fetch embed data", "Small");
        }
    };

    const handleQuickTest = async () => {
        const api = getAPI();
        if (!api) {
            showToast("❌ Plugin not ready", "Small");
            return;
        }

        if (!targetUserId.trim() || !fromUserId.trim()) {
            showToast("❌ Fill in both User IDs first", "Small");
            return;
        }

        try {
            await api.quickTest(targetUserId.trim(), fromUserId.trim());
        } catch (e) {
            showToast("❌ Test failed", "Small");
        }
    };

    const pasteTargetId = async () => {
        try {
            const text = await clipboard.getString();
            if (text) {
                setTargetUserId(text.trim());
                showToast("📋 Pasted target user ID", "clipboard");
            }
        } catch (e) {
            showToast("Failed to paste", "Small");
        }
    };

    const pasteFromId = async () => {
        try {
            const text = await clipboard.getString();
            if (text) {
                setFromUserId(text.trim());
                showToast("📋 Pasted sender user ID", "clipboard");
            }
        } catch (e) {
            showToast("Failed to paste", "Small");
        }
    };

    const pasteUrl = async () => {
        try {
            const text = await clipboard.getString();
            if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
                setEmbedUrl(text.trim());
                showToast("📋 Pasted URL", "clipboard");
            } else {
                showToast("❌ Clipboard doesn't contain a valid URL", "Small");
            }
        } catch (e) {
            showToast("Failed to paste", "Small");
        }
    };

    const setCurrentTime = () => {
        setMessageTimestamp(new Date().toISOString());
        showToast("⏰ Set to current time", "Check");
    };

    const setEmbedCurrentTime = () => {
        setEmbedTimestamp(new Date().toISOString());
        showToast("⏰ Set embed to current time", "Check");
    };

    const messageCount = React.useMemo(() => {
        return Object.values(storage.persistentMessages || {}).reduce(
            (acc: number, msgs: any) => acc + (Array.isArray(msgs) ? msgs.length : 0),
            0
        );
    }, [storage.persistentMessages]);

    const channelCount = Object.keys(storage.persistentMessages || {}).length;

    return (
        <ScrollView>
            <FormSection title="MESSAGE FAKER v3.2.0">
                <FormText style={styles.infoText}>
                    💬 Inject fake messages into DMs with auto-embed from URLs!
                </FormText>
                <FormText style={styles.successText}>
                    ✨ NEW: Paste any URL and get Discord embeds automatically!
                </FormText>
                <FormSwitch
                    label="Enable Plugin"
                    subLabel="Turn the plugin on/off"
                    value={storage.enabled}
                    onValueChange={(v: boolean) => {
                        storage.enabled = v;
                        showToast(v ? "✅ Enabled" : "❌ Disabled", "Check");
                    }}
                />

                <FormSwitch
                    label="Auto-Inject on Startup"
                    subLabel="Automatically show fake messages when Discord starts"
                    value={storage.autoInjectOnStartup}
                    onValueChange={(v: boolean) => {
                        storage.autoInjectOnStartup = v;
                    }}
                />

                <FormSwitch
                    label="Prevent Message Deletion"
                    subLabel="Fake messages can't be deleted (they reinject)"
                    value={storage.preventMessageDeletion}
                    onValueChange={(v: boolean) => {
                        storage.preventMessageDeletion = v;
                    }}
                />

                <FormSwitch
                    label="Debug Mode"
                    subLabel="Enable detailed logging"
                    value={storage.debug}
                    onValueChange={(v: boolean) => {
                        storage.debug = v;
                    }}
                />
            </FormSection>

            <FormDivider />

            <FormSection title="CREATE FAKE MESSAGE">
                <FormText style={styles.infoText}>
                    📝 Create a fake message in someone's DM
                </FormText>

                <FormInput
                    title="TARGET USER ID (Whose DM)"
                    placeholder="User ID of person whose DM you want to inject into"
                    value={targetUserId}
                    onChange={setTargetUserId}
                />

                <TouchableOpacity style={styles.button} onPress={pasteTargetId}>
                    <Text style={styles.buttonText}>📋 Paste Target User ID</Text>
                </TouchableOpacity>

                <FormInput
                    title="FROM USER ID (Who message is from)"
                    placeholder="User ID of who the message appears to be from"
                    value={fromUserId}
                    onChange={setFromUserId}
                />

                <TouchableOpacity style={styles.button} onPress={pasteFromId}>
                    <Text style={styles.buttonText}>📋 Paste Sender User ID</Text>
                </TouchableOpacity>

                <FormInput
                    title="MESSAGE CONTENT"
                    placeholder="The message text (supports multiple lines)"
                    value={messageContent}
                    onChange={setMessageContent}
                    multiline={true}
                    numberOfLines={4}
                />

                <FormInput
                    title="MESSAGE TIMESTAMP (Optional)"
                    placeholder="ISO 8601 format: 2024-01-15T12:30:00Z"
                    value={messageTimestamp}
                    onChange={setMessageTimestamp}
                />

                <TouchableOpacity style={styles.button} onPress={setCurrentTime}>
                    <Text style={styles.buttonText}>⏰ Set Current Time</Text>
                </TouchableOpacity>

                <FormText style={styles.warningText}>
                    💡 Leave timestamp empty to use current time
                </FormText>
            </FormSection>

            <FormDivider />

            <FormSection title="✨ AUTO-EMBED FROM URL (NEW!)">
                <FormText style={styles.successText}>
                    🔗 Paste any URL and Discord will auto-generate an embed just like when you send a link!
                </FormText>
                
                <FormText style={styles.infoText}>
                    Works with: YouTube, Twitter, GitHub, news sites, and most websites with OpenGraph metadata.
                </FormText>

                <FormInput
                    title="EMBED URL"
                    placeholder="https://github.com/username/repo"
                    value={embedUrl}
                    onChange={setEmbedUrl}
                />

                <TouchableOpacity style={styles.button} onPress={pasteUrl}>
                    <Text style={styles.buttonText}>📋 Paste URL from Clipboard</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                    style={[styles.button, styles.infoButton]} 
                    onPress={handleTestUrlEmbed}
                >
                    <Text style={styles.buttonText}>🔍 Preview & Load Embed Data</Text>
                </TouchableOpacity>

                <FormText style={styles.warningText}>
                    💡 The embed will be fetched automatically when you send the message, OR you can preview it first to edit manually below
                </FormText>
            </FormSection>

            <FormDivider />

            <FormSection title="MANUAL EMBED (Optional)">
                <FormText style={styles.infoText}>
                    📎 Manually customize your embed (or edit auto-fetched data)
                </FormText>

                <FormInput
                    title="EMBED TITLE"
                    placeholder="Title (max 256 characters)"
                    value={embedTitle}
                    onChange={setEmbedTitle}
                />

                <FormInput
                    title="EMBED DESCRIPTION"
                    placeholder="Description (max 4096 characters)"
                    value={embedDescription}
                    onChange={setEmbedDescription}
                    multiline={true}
                    numberOfLines={4}
                />

                <FormInput
                    title="EMBED COLOR"
                    placeholder="Hex (#5865F2) or Decimal (5793266)"
                    value={embedColor}
                    onChange={setEmbedColor}
                />

                <FormInput
                    title="IMAGE URL"
                    placeholder="Large image at bottom"
                    value={embedImage}
                    onChange={setEmbedImage}
                />

                <FormInput
                    title="THUMBNAIL URL"
                    placeholder="Small image at top-right"
                    value={embedThumbnail}
                    onChange={setEmbedThumbnail}
                />

                <FormText style={styles.infoText}>
                    👤 Embed Author Section
                </FormText>

                <FormInput
                    title="AUTHOR NAME"
                    placeholder="Name (max 256 characters)"
                    value={embedAuthorName}
                    onChange={setEmbedAuthorName}
                />

                <FormInput
                    title="AUTHOR URL"
                    placeholder="URL when author name is clicked"
                    value={embedAuthorUrl}
                    onChange={setEmbedAuthorUrl}
                />

                <FormInput
                    title="AUTHOR ICON URL"
                    placeholder="Small icon next to author name"
                    value={embedAuthorIcon}
                    onChange={setEmbedAuthorIcon}
                />

                <FormText style={styles.infoText}>
                    🦶 Embed Footer Section
                </FormText>

                <FormInput
                    title="FOOTER TEXT"
                    placeholder="Footer text (max 2048 characters)"
                    value={embedFooterText}
                    onChange={setEmbedFooterText}
                />

                <FormInput
                    title="FOOTER ICON URL"
                    placeholder="Small icon next to footer text"
                    value={embedFooterIcon}
                    onChange={setEmbedFooterIcon}
                />

                <FormInput
                    title="EMBED TIMESTAMP"
                    placeholder="ISO 8601: 2024-01-15T12:30:00Z"
                    value={embedTimestamp}
                    onChange={setEmbedTimestamp}
                />

                <TouchableOpacity style={styles.button} onPress={setEmbedCurrentTime}>
                    <Text style={styles.buttonText}>⏰ Set Current Time</Text>
                </TouchableOpacity>

                <FormText style={styles.infoText}>
                    📊 Embed Fields (Advanced)
                </FormText>

                <FormInput
                    title="FIELDS (JSON Array)"
                    placeholder='[{"name":"Field 1","value":"Value 1","inline":true}]'
                    value={embedFields}
                    onChange={setEmbedFields}
                />

                <FormText style={styles.warningText}>
                    💡 Max 25 fields. Field name: max 256 chars, value: max 1024 chars
                </FormText>
            </FormSection>

            <FormDivider />

            <FormSection title="SEND MESSAGE">
                <TouchableOpacity
                    style={[styles.button, styles.successButton]}
                    onPress={handleSendFakeMessage}
                >
                    <Text style={styles.buttonText}>✉️ Send Fake Message</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.button, styles.warningButton]}
                    onPress={handleQuickTest}
                >
                    <Text style={styles.buttonText}>🧪 Quick Test Message</Text>
                </TouchableOpacity>
            </FormSection>

            <FormDivider />

            <FormSection title="CONSOLE API EXAMPLES">
                <FormText style={styles.infoText}>
                    🔧 Advanced usage via console:
                </FormText>

                <FormText style={styles.successText}>
                    ✨ NEW: Auto-embed from URL
                </FormText>

                <Text style={styles.codeText}>
                    {`// Auto-generate embed from URL
__MESSAGE_FAKER__.fakeMessage({
  targetUserId: "USER_ID",
  fromUserId: "USER_ID",
  content: "Check this out!",
  embedUrl: "https://github.com/user/repo",
  persistent: true
});`}
                </Text>

                <Text style={styles.codeText}>
                    {`// Test URL embed fetching
const embed = await __MESSAGE_FAKER__
  .fetchOpenGraphData("https://example.com");
console.log(embed);`}
                </Text>

                <Text style={styles.codeText}>
                    {`// Full manual embed example
__MESSAGE_FAKER__.fakeMessage({
  targetUserId: "USER_ID",
  fromUserId: "USER_ID",
  content: "Check this embed!",
  embed: {
    title: "Amazing Embed",
    description: "Full description",
    url: "https://example.com",
    color: 0x5865F2,
    timestamp: "2024-01-15T12:30:00Z",
    author: {
      name: "Author Name",
      url: "https://example.com",
      icon_url: "https://i.imgur.com/..."
    },
    image: {
      url: "https://i.imgur.com/..."
    },
    fields: [
      {
        name: "Field 1",
        value: "Value 1",
        inline: true
      }
    ]
  },
  persistent: true
});`}
                </Text>

                <FormText style={styles.infoText}>
                    Open debug console to use these commands
                </FormText>
            </FormSection>

            <FormDivider />

            <FormSection title="EMBED COLOR REFERENCE">
                <FormText style={styles.infoText}>
                    🎨 Common Discord colors:
                </FormText>
                <Text style={styles.codeText}>
                    {`Blurple: #5865F2 (5793266)
Green: #57F287 (5763719)
Yellow: #FEE75C (16705372)
Fuchsia: #EB459E (15418782)
Red: #ED4245 (15548997)
White: #FFFFFF (16777215)
Black: #000000 (0)`}
                </Text>
            </FormSection>

            <FormDivider />

            <FormSection title="STATISTICS">
                <FormText style={styles.infoText}>
                    📊 Current fake messages: {messageCount} messages in {channelCount} channels
                </FormText>
            </FormSection>

            <FormDivider />

            <FormSection title="DANGER ZONE">
                <TouchableOpacity
                    style={[styles.button, styles.dangerButton]}
                    onPress={() => {
                        const api = getAPI();
                        if (api) {
                            api.clearAllMessages();
                        }
                        setTargetUserId("");
                        setFromUserId("");
                        setMessageContent("");
                        setMessageTimestamp("");
                        setEmbedUrl("");
                        setEmbedTitle("");
                        setEmbedDescription("");
                        setEmbedColor("");
                        setEmbedImage("");
                        setEmbedThumbnail("");
                        setEmbedAuthorName("");
                        setEmbedAuthorUrl("");
                        setEmbedAuthorIcon("");
                        setEmbedFooterText("");
                        setEmbedFooterIcon("");
                        setEmbedTimestamp("");
                        setEmbedFields("");
                    }}
                >
                    <Text style={styles.buttonText}>🗑️ Clear ALL Fake Messages</Text>
                </TouchableOpacity>

                <FormText style={styles.warningText}>
                    ⚠️ This will remove all fake messages from storage. They will disappear on next reload.
                </FormText>
            </FormSection>

            <FormText style={[styles.infoText, { marginTop: 16, marginBottom: 32, textAlign: "center" as const }]}>
                MessageFaker v3.2.0 - Auto-Embed Edition
                {'\n'}✨ Auto-Embed from URLs • Timestamp Control • Full Embed Support
            </FormText>
        </ScrollView>
    );
};
