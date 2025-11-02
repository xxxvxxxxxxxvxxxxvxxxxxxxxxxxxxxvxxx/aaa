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
    const [embedTitle, setEmbedTitle] = React.useState("");
    const [embedDescription, setEmbedDescription] = React.useState("");
    const [embedImage, setEmbedImage] = React.useState("");

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

        if (!messageContent.trim() && !embedTitle.trim()) {
            showToast("❌ Enter message content or embed", "Small");
            return;
        }

        const embed = (embedTitle || embedDescription || embedImage) ? {
            title: embedTitle || undefined,
            description: embedDescription || undefined,
            image: embedImage ? { url: embedImage } : undefined,
            thumbnail: embedImage ? { url: embedImage } : undefined,
            type: 'rich'
        } : undefined;

        try {
            const success = await api.fakeMessage({
                targetUserId: targetUserId.trim(),
                fromUserId: fromUserId.trim(),
                content: messageContent.trim(),
                embed: embed,
                persistent: true
            });

            if (success) {
                showToast("✅ Fake message sent!", "Check");
            }
        } catch (e) {
            showToast("❌ Failed to send message", "Small");
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

    const messageCount = React.useMemo(() => {
        return Object.values(storage.persistentMessages || {}).reduce(
            (acc: number, msgs: any) => acc + (Array.isArray(msgs) ? msgs.length : 0),
            0
        );
    }, [storage.persistentMessages]);

    const channelCount = Object.keys(storage.persistentMessages || {}).length;

    return (
        <ScrollView>
            <FormSection title="MESSAGE FAKER">
                <FormText style={styles.infoText}>
                    💬 Inject fake messages into DMs from anyone.
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
                    placeholder="The message text"
                    value={messageContent}
                    onChange={setMessageContent}
                />

                <FormText style={styles.infoText}>
                    📎 Optional: Add an embed
                </FormText>

                <FormInput
                    title="EMBED TITLE"
                    placeholder="Optional embed title"
                    value={embedTitle}
                    onChange={setEmbedTitle}
                />

                <FormInput
                    title="EMBED DESCRIPTION"
                    placeholder="Optional embed description"
                    value={embedDescription}
                    onChange={setEmbedDescription}
                />

                <FormInput
                    title="EMBED IMAGE URL"
                    placeholder="Optional image URL"
                    value={embedImage}
                    onChange={setEmbedImage}
                />

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

            <FormSection title="CONSOLE API">
                <FormText style={styles.infoText}>
                    🔧 You can also use the console for advanced usage:
                </FormText>

                <Text style={styles.codeText}>
                    {`// Send fake message
__MESSAGE_FAKER__.fakeMessage({
  targetUserId: "USER_ID",
  fromUserId: "USER_ID",
  content: "Hello!",
  persistent: true
});`}
                </Text>

                <Text style={styles.codeText}>
                    {`// With embed
__MESSAGE_FAKER__.fakeMessage({
  targetUserId: "USER_ID",
  fromUserId: "USER_ID",
  content: "Check this out!",
  embed: {
    title: "Cool Title",
    description: "Description",
    image: { url: "https://..." }
  }
});`}
                </Text>

                <FormText style={styles.infoText}>
                    Open Kettu debug console to use these commands
                </FormText>
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
                        setEmbedTitle("");
                        setEmbedDescription("");
                        setEmbedImage("");
                    }}
                >
                    <Text style={styles.buttonText}>🗑️ Clear ALL Fake Messages</Text>
                </TouchableOpacity>

                <FormText style={styles.warningText}>
                    ⚠️ This will remove all fake messages from storage. They will disappear on next reload.
                </FormText>
            </FormSection>

            <FormText style={[styles.infoText, { marginTop: 16, marginBottom: 32, textAlign: "center" as const }]}>
                MessageFaker v1.0.0 for Kettu/Bunny/Vendetta
            </FormText>
        </ScrollView>
    );
};
