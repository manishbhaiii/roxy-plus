const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'autoreactions.json');

let config = {
    global: true,
    enabledServers: [], // Array of Guild IDs
    enabledChannels: [], // Array of Channel IDs
    textTriggers: {}, // { "trigger": ["emoji1", "emoji2"] }
    userTriggers: {}  // { "userId": ["emoji1"] }
};

function loadData() {
    if (!fs.existsSync(FILE)) return config;
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        config = {
            global: data.global ?? true,
            enabledServers: data.enabledServers || [],
            enabledChannels: data.enabledChannels || [],
            textTriggers: data.textTriggers || {},
            userTriggers: data.userTriggers || {}
        };
        return config;
    } catch (e) { return config; }
}

function saveData(newConfig) {
    if (newConfig) config = newConfig;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(config, null, 2));
}

function isReactionEnabled(channelId, guildId) {
    if (config.enabledChannels.includes(channelId)) return true;
    if (guildId && config.enabledServers.includes(guildId)) return true;
    return config.global;
}

module.exports = {
    loadData,
    saveData,

    initialize: (client) => {
        console.log('[AutoReaction] Initializing...');
        loadData();

        client.on('messageCreate', async (message) => {
            if ((message.author.bot && message.author.id !== client.user.id) || !message.guild) return; // Ignore other bots/DMs usually
            // Prevent ignoring self to allow selfbot to react to own messages

            // Check if enabled
            // Note: If global is TRUE, it works everywhere unless restricted?
            // The example logic: 
            // 1. Channel specific -> True
            // 2. Server specific -> True
            // 3. Fallback -> Global
            // This means if Global is True, it works everywhere. If Global is False, only works in Whitelisted Channels/Servers.
            if (!isReactionEnabled(message.channel.id, message.guild.id)) return;

            try {
                // User Triggers
                if (config.userTriggers[message.author.id]) {
                    const emojis = config.userTriggers[message.author.id];
                    for (const emoji of emojis) {
                        try { await message.react(emoji); } catch (e) { }
                    }
                }

                // Text Triggers
                const content = message.content.toLowerCase();
                for (const trigger in config.textTriggers) {
                    if (content.includes(trigger.toLowerCase())) {
                        const emojis = config.textTriggers[trigger];
                        for (const emoji of emojis) {
                            try { await message.react(emoji); } catch (e) { }
                        }
                    }
                }
            } catch (e) {
                console.error('[AutoReaction] Error:', e);
            }
        });
    }
};
