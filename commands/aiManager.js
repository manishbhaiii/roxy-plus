const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONFIG_PATH = path.join(__dirname, '../data/ai_config.json');
const HISTORY_PATH = path.join(__dirname, '../data/chat_history.json');

// Initialize API
const openai = new OpenAI({
    apiKey: process.env.AI_API,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// Default Config
const DEFAULT_CONFIG = {
    global: false,
    enabledServers: [],
    enabledChannels: [],
    dmUsers: [],
    enabledGroups: [], // Always reply
    enabledGroupsMention: [], // Reply only on mention
    freeWillChannels: [],
    aiName: "Roxy",
    backstory: "You are Roxy, a helpful and witty AI assistant.",
    personality: "Friendly, helpful, and sometimes sarcastic.",
    rules: "Keep responses concise. Do not ping @everyone.",
    modelType: "slow",
    bannedWords: ["age", "year old", "y/o", "birth"]
};

function loadData() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            const dir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4));
            return DEFAULT_CONFIG;
        }
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        if (!raw.trim()) throw new Error('Empty file');

        let data = JSON.parse(raw);
        // Merge with defaults to ensure all fields exist
        data = { ...DEFAULT_CONFIG, ...data };

        return data;
    } catch (e) {
        console.error('[AI Manager] Failed to load config, using defaults:', e.message);
        return DEFAULT_CONFIG;
    }
}

function saveData(data) {
    try {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // Merge with existing to preserve unseen keys
        const existing = loadData();
        const finalData = { ...existing, ...data };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(finalData, null, 4));
    } catch (e) {
        console.error('[AI Manager] Failed to save config:', e);
    }
}

function loadHistory() {
    if (!fs.existsSync(HISTORY_PATH)) {
        fs.writeFileSync(HISTORY_PATH, JSON.stringify({}, null, 4));
        return {};
    }
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
}

function saveHistory(history) {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 4));
}

function getContext(userId, config) {
    const history = loadHistory();
    const userHistory = history[userId] || [];

    // System Prompt
    const systemMsg = {
        role: "system",
        content: `Name: ${config.aiName}\nBackstory: ${config.backstory}\nPersonality: ${config.personality}\nRules: ${config.rules}`
    };

    const messages = [systemMsg, ...userHistory];
    return messages;
}

async function addHistory(userId, userContent, aiContent) {
    let history = loadHistory();
    if (!history[userId]) history[userId] = [];

    history[userId].push({ role: "user", content: userContent });
    history[userId].push({ role: "assistant", content: aiContent });

    // Keep last 10 messages (5 pairs)
    if (history[userId].length > 10) {
        history[userId] = history[userId].slice(history[userId].length - 10);
    }

    saveHistory(history);
}

// Core Chat Function
async function generateReply(userId, userContent) {
    const config = loadData();
    const messages = getContext(userId, config);

    // Append current message
    messages.push({ role: "user", content: userContent });

    // Determine Model Parameters
    let modelName = "moonshotai/kimi-k2-thinking";
    let temp = 1;
    let maxTokens = 16384;

    if (config.modelType === "fast") {
        modelName = "moonshotai/kimi-k2-instruct-0905";
        temp = 0.6;
        maxTokens = 4096;
    }

    try {
        const completion = await openai.chat.completions.create({
            model: modelName,
            messages: messages,
            temperature: temp,
            top_p: 0.9,
            max_tokens: maxTokens,
            stream: true
        });

        let fullContent = "";
        let fullReasoning = "";

        for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.reasoning_content) {
                fullReasoning += delta.reasoning_content;
                // process.stdout.write(delta.reasoning_content); // Hidden
            }
            if (delta?.content) {
                fullContent += delta.content;
                // process.stdout.write(delta.content); // Hidden
            }
        }

        console.log(`\n[AI] Reply complete (Model: ${config.modelType}).`);

        // Strip out <think> blocks if the model returns them in the main content chunk
        fullContent = fullContent.replace(/<think>[\s\S]*?(?:<\/think>|$)\s*/gi, '');

        // Save to history
        if (fullContent.trim()) {
            await addHistory(userId, userContent, fullContent);
        }

        return fullContent;

    } catch (error) {
        console.error("[AI] Error generating reply:", error);
        return "what you mean?";
    }
}

// Initialization and Event Listening
function initialize(client) {
    console.log("[AI System] Initializing...");

    client.on('messageCreate', async (message) => {
        try {
            if (message.author.bot) return;
            // CRITICAL FIX: Prevent self-reply loop & specific crashes
            if (!client.user || message.author.id === client.user.id) return;

            // Ignore system messages and non-text content
            if (message.system || !message.content || !message.content.trim()) return;

            const ignoredTypes = ['RECIPIENT_ADD', 'RECIPIENT_REMOVE', 'CALL', 'CHANNEL_NAME_CHANGE', 'CHANNEL_ICON_CHANGE', 'PINS_ADD'];
            if (ignoredTypes.includes(message.type)) return;

            const config = loadData();
            const content = message.content;
            const guildId = message.guild?.id;
            const channelId = message.channel.id;
            const authorId = message.author.id;

            // Banned Words Check
            if (config.bannedWords && config.bannedWords.some(w => content.toLowerCase().includes(w.toLowerCase()))) {
                return;
            }

            // Flags
            let shouldReply = false;
            let freeWillDelay = 0;

            // 1. DM Logic (or Group DM)
            if (!guildId) {
                // Check if user is whitelisted for DMs
                if (config.dmUsers && config.dmUsers.includes(authorId)) {
                    shouldReply = true;
                }
                // Check if group/channel is whitelisted (ALWAYS REPLY)
                if (config.enabledGroups && config.enabledGroups.includes(channelId)) {
                    shouldReply = true;
                }
                // Check if group/channel is whitelisted (MENTION ONLY)
                if (config.enabledGroupsMention && config.enabledGroupsMention.includes(channelId)) {
                    if (message.mentions.users.has(client.user.id)) {
                        shouldReply = true;
                    }
                }
            } else {
                // Server Logic

                // Check Free Will
                let isFreeWill = false;
                if (config.freeWillChannels) {
                    const fwItem = config.freeWillChannels.find(x => typeof x === 'object' ? x.id === channelId : x === channelId);
                    if (fwItem) {
                        shouldReply = true;
                        isFreeWill = true;
                        freeWillDelay = typeof fwItem === 'object' ? (fwItem.delay || 0) : 0;
                    }
                }
                
                // Check Mention/Reply triggers
                if (!isFreeWill) {
                    const isMentioned = message.mentions.users.has(client.user.id);
                    // Reply logic could be added here if needed

                    if (isMentioned) {
                        if (config.global) {
                            shouldReply = true;
                        } else {
                            const serverAllowed = config.enabledServers && config.enabledServers.includes(guildId);
                            const channelAllowed = config.enabledChannels && config.enabledChannels.includes(channelId);
                            if (serverAllowed || channelAllowed) {
                                shouldReply = true;
                            }
                        }
                    }
                }
            }

            if (content.includes('@everyone') || content.includes('@here')) {
                // Ignore logic
            }

            if (shouldReply) {
                const startTime = Date.now();
                message.channel.sendTyping().catch(() => { });
                // Generate
                // Prepend username for context
                const effectiveContent = `(User: ${message.author.username}) ${content}`;
                const reply = await generateReply(authorId, effectiveContent);

                if (freeWillDelay > 0) {
                    const timeTaken = Date.now() - startTime;
                    const targetDelayMs = freeWillDelay * 1000;
                    if (targetDelayMs > timeTaken) {
                        await new Promise(resolve => setTimeout(resolve, targetDelayMs - timeTaken));
                    }
                }

                if (reply && reply.trim().length > 0) {
                    try {
                        await message.reply(reply);
                    } catch (e) {
                        // Fallback: If reply fails (e.g. Invalid Form Body), try normal send
                        // console.warn("[AI] Reply failed, attempting plain send...", e.message);
                        await message.channel.send(reply).catch(err => console.error("[AI] Failed to send:", err));
                    }
                }
            }
        } catch (error) {
            console.error("Error in AI messageCreate:", error);
        }
    });
}

module.exports = {
    loadData,
    saveData,
    initialize
};
