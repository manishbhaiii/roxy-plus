require('dotenv').config();

// Suppress annoying DeprecationWarnings from dependencies (like url.parse())
process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning') return;
    console.warn(warning.name, warning.message);
});

require('./logger').initLogger();
const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');

const client = new Client({
    checkUpdate: false
});

// Initialize music system
const Lavalink = require('./music/lavalink');
const queueManager = require('./music/queue');

client.ttsMap = new Map();

// Initialize Lavalink if configured
let lavalink = null;
if (process.env.LAVALINK_WS && process.env.LAVALINK_REST && process.env.LAVALINK_PASSWORD) {
    lavalink = new Lavalink({
        restHost: process.env.LAVALINK_REST,
        wsHost: process.env.LAVALINK_WS,
        password: process.env.LAVALINK_PASSWORD,
        clientName: process.env.CLIENT_NAME || 'RoxyPlus',
    });
}

// Voice states storage
const voiceStates = {};

client.commands = new Map();
client.lavalink = lavalink;
client.queueManager = queueManager;
client.lavalinkVoiceStates = voiceStates;

// Allowed Users Logic
const allowedManager = require('./commands/allowedManager');

function isAllowedUser(userId) {
    // Only verify against allowed list (Removed automatic self-allow as requested)
    return allowedManager.isAllowed(userId);
}

const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.name) {
                client.commands.set(command.name, command);
            }
        } catch (error) {
            console.error('Error loading command ' + file + ':', error);
        }
    }
}

const dashboard = require('./dashboard/index');

client.on('ready', () => {
    console.log('Logged in as ' + client.user.tag);
    console.log('User ID: ' + client.user.id);
    console.log('Roxy+ is ready!');
    console.log('Loaded ' + client.commands.size + ' commands');

    // Connect to Lavalink if available
    if (client.lavalink) {
        client.lavalink.connect(client.user.id);
        console.log('Connecting to Lavalink...');
    }

    // Initialize RPC
    const rpcManager = require('./commands/rpcManager');
    rpcManager.initialize(client);

    // Initialize Auto Reaction
    const reactionManager = require('./commands/reactionManager');
    reactionManager.initialize(client);

    // Initialize AI System
    const aiManager = require('./commands/aiManager');
    aiManager.initialize(client);

    // Initialize Status Manager
    const statusManager = require('./commands/statusManager');
    // Note: rpcManager.initialize already handles setting the initial merged presence

    // Heartbeat to prevent status from disappearing (every 10 minutes)
    setInterval(async () => {
        const rpcManager = require('./commands/rpcManager');
        const data = rpcManager.loadData();
        await rpcManager.setPresence(client, data);
    }, 10 * 60 * 1000);

    // Initialize Mirror System
    const mirrorManager = require('./commands/mirrorManager');
    mirrorManager.initialize(client);

    // Initialize Auto Msg System
    const autoMsg = require('./commands/autoMsg');
    autoMsg.initialize(client);

    // Initialize Timed Msg System
    const timedMsg = require('./commands/timedMsg');
    timedMsg.initialize(client);

    // Initialize Waifu/Fun System
    const waifuManager = require('./commands/waifuManager');
    waifuManager.initialize(client);

    // Start Dashboard
    dashboard(client);
});

// Voice state handling for Lavalink
if (client.lavalink) {
    client.ws.on('VOICE_STATE_UPDATE', (packet) => {
        if (packet.user_id !== client.user.id) return;

        const guildId = packet.guild_id;
        if (!voiceStates[guildId]) voiceStates[guildId] = {};
        voiceStates[guildId].sessionId = packet.session_id;
        if (packet.channel_id) {
            voiceStates[guildId].channelId = packet.channel_id;
        }
        console.log(`[Voice] State update for guild ${guildId}`);
    });

    client.ws.on('VOICE_SERVER_UPDATE', (packet) => {
        const guildId = packet.guild_id;
        if (!voiceStates[guildId]) voiceStates[guildId] = {};
        voiceStates[guildId].token = packet.token;
        voiceStates[guildId].endpoint = packet.endpoint;
        console.log(`[Voice] Server update for guild ${guildId}`);
    });

    // Lavalink event handlers
    client.lavalink.on('ready', () => {
        console.log('[Lavalink] Session established');
    });

    client.lavalink.on('event', async (evt) => {
        console.log(`[Lavalink Event] Type: ${evt.type}, Guild: ${evt.guildId}`);

        if (evt.type === 'TrackEndEvent') {
            if (evt.reason === 'finished' || evt.reason === 'loadFailed') {
                const queue = queueManager.get(evt.guildId);
                if (!queue) return;

                if (queue.nowPlaying) {
                    if (queue.loop === 'track') {
                        queue.songs.unshift(queue.nowPlaying);
                    } else if (queue.loop === 'queue') {
                        queue.history.push(queue.nowPlaying);
                        queue.songs.push(queue.nowPlaying);
                    } else {
                        queue.history.push(queue.nowPlaying);
                    }
                }

                let nextSong = queueManager.getNext(evt.guildId);

                // Queue is empty, refill if autoplay is enabled
                if (queue.autoplay && queue.songs.length < 5) {
                    await queueManager.fillAutoplayQueue(client, evt.guildId);
                    if (!nextSong) {
                        nextSong = queueManager.getNext(evt.guildId);
                    }
                }

                if (!nextSong) {
                    await client.lavalink.destroyPlayer(evt.guildId);
                    queueManager.delete(evt.guildId);
                    if (queue.textChannel) {
                        queue.textChannel.send('```Queue finished' + (queue.autoplay ? ' (Autoplay failed to find songs)' : '') + '```');
                    }
                    return;
                }

                queue.nowPlaying = nextSong;
                const voiceState = voiceStates[evt.guildId];

                if (voiceState && voiceState.token && voiceState.sessionId && voiceState.endpoint) {
                    try {
                        await client.lavalink.updatePlayer(evt.guildId, nextSong, voiceState, {
                            volume: queue.volume,
                            filters: queue.filters
                        });

                        if (queue.textChannel) {
                            let nowPlayingMsg = '```\n';
                            nowPlayingMsg += '╭─[ NOW PLAYING ]─╮\n\n';
                            nowPlayingMsg += `  🎵 ${nextSong.info.title}\n`;
                            nowPlayingMsg += `  👤 ${nextSong.info.author}\n`;
                            nowPlayingMsg += '\n╰──────────────────────────────────╯\n```';
                            queue.textChannel.send(nowPlayingMsg);
                        }
                    } catch (err) {
                        console.error('[Auto-play Error]:', err);
                        if (queue.textChannel) {
                            queue.textChannel.send('```Error playing next song```');
                        }
                    }
                }
            }
        }
    });

    client.lavalink.on('playerUpdate', (packet) => {
        const queue = queueManager.get(packet.guildId);
        if (queue && packet.state) {
            queue.position = packet.state.position;
            queue.lastUpdate = Date.now();
        }
    });
}

// AFK & Logging Logic
const afkCooldowns = new Map();
// Cleanup old cooldowns every hour
setInterval(() => {
    const now = Date.now();
    for (const [id, time] of afkCooldowns) {
        if (now - time > 3600000) afkCooldowns.delete(id);
    }
}, 3600000);

// --- WELCOMER SYSTEM ---
client.on('guildMemberAdd', async member => {
    try {
        const welcomerManager = require('./commands/welcomerManager');
        const setup = welcomerManager.getSetup(member.guild.id);

        if (setup && setup.channelId) {
            const channel = member.guild.channels.cache.get(setup.channelId);
            if (channel) {
                if (setup.welcomeType === 'text') {
                    let txt = setup.textMessage || 'hey {user} welcome to the {server} you are {count} member';
                    txt = txt.replace(/{user}/g, `<@${member.user.id}>`);
                    txt = txt.replace(/{server}/g, member.guild.name || 'Server');
                    txt = txt.replace(/{count}/g, member.guild.memberCount || 1);
                    await channel.send(txt);
                } else {
                    const { createCanvas, loadImage } = require('canvas');
                    const fs = require('fs');
                    const path = require('path');

                // Find custom wallpaper in data folder
                const dataDir = path.join(__dirname, 'data');
                const extList = ['.png', '.jpg', '.jpeg', '.webp'];
                let bgPath = path.join(__dirname, 'dashboard', 'public', 'welcome.jpg'); // Fallback default

                for (const ext of extList) {
                    const checkPath = path.join(dataDir, `welcome${ext}`);
                    if (fs.existsSync(checkPath)) {
                        bgPath = checkPath;
                        break;
                    }
                }

                // Create Canvas (size: 1024x450)
                const canvas = createCanvas(1024, 450);
                const ctx = canvas.getContext('2d');

                // Draw background
                const background = await loadImage(bgPath);
                ctx.drawImage(background, 0, 0, canvas.width, canvas.height);

                // Draw Semi-Transparent Dark Overlay for text readability
                ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Text Sanitization
                const cleanGuild = member.guild.name.replace(/[^\x00-\x7F]/g, "").trim() || "Server";
                let cleanUser = member.user.username.replace(/[^\x00-\x7F]/g, "").trim() || "User";
                if (member.user.discriminator && member.user.discriminator !== '0') {
                    cleanUser += `#${member.user.discriminator}`;
                }

                // Set Color based on user setup or default white
                let userColor = setup.textcolor || '#ffffff';
                if (/^[0-9A-Fa-f]{6}$/.test(userColor)) userColor = '#' + userColor;

                ctx.textAlign = 'center';

                const lines = (setup.cardMessage || "WELCOME TO {server}\n{user}\nMember #{count}").split('\n');
                let startY = 290;
                
                lines.forEach((line) => {
                    let parsedLine = line.replace(/{server}/gi, cleanGuild)
                                         .replace(/{user}/gi, cleanUser)
                                         .replace(/{count}/gi, member.guild.memberCount.toString());
                    
                    if (line.toLowerCase().includes('{user}')) {
                        ctx.font = 'bold 50px Arial';
                        ctx.fillStyle = userColor;
                        startY += 10;
                    } else {
                        ctx.font = 'bold 36px Arial';
                        ctx.fillStyle = '#ffffff';
                    }
                    ctx.fillText(parsedLine, canvas.width / 2, startY);
                    startY += 45;
                });

                // Draw Avatar Circular Cutout
                const userAvatar = member.user.displayAvatarURL({ format: 'png', size: 256 }) || 'https://cdn.discordapp.com/embed/avatars/0.png';
                const avatar = await loadImage(userAvatar);

                const arcX = canvas.width / 2;
                const arcY = 140;
                const arcRadius = 90;

                ctx.save();
                ctx.beginPath();
                ctx.arc(arcX, arcY, arcRadius, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(avatar, arcX - arcRadius, arcY - arcRadius, arcRadius * 2, arcRadius * 2);
                ctx.restore();

                // Add Avatar Border
                ctx.beginPath();
                ctx.arc(arcX, arcY, arcRadius, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.lineWidth = 8;
                ctx.strokeStyle = userColor;
                ctx.stroke();

                const buffer = canvas.toBuffer('image/png');

                await channel.send({
                    files: [{
                        attachment: buffer,
                        name: 'welcome.png'
                    }]
                });
                }
            }
        }
    } catch (e) {
        console.error('Welcomer Canvas Event Error:', e);
    }
});

client.on('messageCreate', async (message) => {
    try {
        if (!message.author) return;

        // --- MIMIC SYSTEM ---
        const mimicManager = require('./commands/mimicManager');
        mimicManager.handle(message, client);

        // --- AFK & LOGGING SYSTEM ---
        const mentionsMe = message.mentions.users.has(client.user.id);
        const isDm = message.channel.type === 'DM';

        if ((mentionsMe || isDm) && message.author.id !== client.user.id) {

            // Read Settings
            const afkPath = path.join(__dirname, 'data', 'afk.json');
            const logPath = path.join(__dirname, 'data', 'afklog.json');

            let afkData = { isOn: false, reason: '', logsEnabled: false };
            if (fs.existsSync(afkPath)) {
                afkData = JSON.parse(fs.readFileSync(afkPath, 'utf8'));
            }

            // 1. LOGGING (If enabled)
            if (afkData.logsEnabled) {
                let logs = [];
                if (fs.existsSync(logPath)) {
                    logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
                }

                let cleanContent = message.content;

                // 1. Clean User Mentions <@ID> or <@!ID>
                cleanContent = cleanContent.replace(/<@!?(\d+)>/g, (match, id) => {
                    const user = client.users.cache.get(id);
                    return user ? `@${user.username}` : match;
                });

                // 2. Clean Role Mentions <@&ID>
                cleanContent = cleanContent.replace(/<@&(\d+)>/g, (match, id) => {
                    const role = message.guild ? message.guild.roles.cache.get(id) : null;
                    return role ? `@${role.name}` : match;
                });

                // 3. Clean Channel Mentions <#ID>
                cleanContent = cleanContent.replace(/<#(\d+)>/g, (match, id) => {
                    const channel = client.channels.cache.get(id);
                    return channel ? `#${channel.name}` : match;
                });

                // 4. Clean Custom Emojis <:name:ID>
                cleanContent = cleanContent.replace(/<a?:(\w+):(\d+)>/g, ':$1:');

                const logEntry = {
                    id: Date.now().toString(),
                    user: message.author.tag,
                    userId: message.author.id,
                    channel: isDm ? 'DM' : message.channel.name || 'Unknown',
                    guild: message.guild ? message.guild.name : 'Direct Message',
                    content: cleanContent,
                    time: new Date().toLocaleString(),
                    link: message.url
                };

                logs.unshift(logEntry);
                if (logs.length > 50) logs = logs.slice(0, 50);
                fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
            }

            // 2. AFK REPLY
            if (afkData.isOn) {
                const now = Date.now();
                const lastReply = afkCooldowns.get(message.author.id) || 0;
                // If dashboard didn't write startTime, default to 0 (so logic still works)
                const startTime = afkData.startTime || 0;
                const cooldown = 5 * 60 * 1000; // 5 minutes

                // Reply if:
                // 1. It's been more than 5 minutes since last reply
                // OR
                // 2. The AFK session started AFTER the last reply (meaning it was reset)
                if (now - lastReply >= cooldown || lastReply < startTime) {
                    const reason = afkData.reason || "I'm currently AFK.";
                    try {
                        // Removed [AFK] prefix as requested
                        await message.reply(`${reason}`);
                        afkCooldowns.set(message.author.id, now);
                    } catch (err) {
                        console.error('Failed to reply to AFK ping:', err);
                    }
                }
            }
        }

        // --- CALCULATOR SYSTEM (Prefix-less) ---
        if (isAllowedUser(message.author.id)) {
            // Instagram Manager
            const igManager = require('./commands/igManager');
            const igHandled = await igManager.handle(message);
            if (igHandled) return;

            // YouTube Manager
            const ytManager = require('./commands/ytManager');
            const ytHandled = await ytManager.handle(message);
            if (ytHandled) return;

            const calculator = require('./commands/calculator');
            // If calculator handled it, return to prevent other command processing (optional, but safe)
            const handled = await calculator.handle(message);
            if (handled) return;

            const currency = require('./commands/currency');
            const currencyHandled = await currency.handle(message);
            if (currencyHandled) return;

            const qrManager = require('./commands/qrManager');
            const qrHandled = await qrManager.handle(message, client, true);
            if (qrHandled) return;

            const ipCommand = require('./commands/ip');
            const ipHandled = await ipCommand.handle(message);
            if (ipHandled) return;

            // --- TTS AUTO-SPEAK SYSTEM ---
            if (message.guild && client.ttsMap && client.ttsMap.has(message.guild.id)) {
                // If TTS is enabled for this guild
                const bindChannelId = client.ttsMap.get(message.guild.id);
                // Only speak if in the bound channel (or unrestricted) and NOT a command
                const prefix = process.env.PREFIX || '!';
                if (message.channel.id === bindChannelId && !message.content.startsWith(prefix)) {
                    const ttsCommand = client.commands.get('tts');
                    if (ttsCommand && ttsCommand.speak) {
                        try {
                            await ttsCommand.speak(message, client);
                        } catch (err) {
                            console.error('TTS Speak Error:', err);
                        }
                        // Don't return, allow logging etc. (or maybe return to prevent other handlers?)
                        // User said "just convert in tts". We can continue processing (like logs).
                    }
                }
            }
        }

        // --- COMMAND HANDLER ---
        const prefix = process.env.PREFIX || '!';
        if (!message.content.startsWith(prefix)) return;

        const args = message.content.slice(prefix.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        if (!isAllowedUser(message.author.id)) {
            return;
        }

        const command = client.commands.get(commandName);

        // --- CLIPBOARD MANAGER START ---
        if (!command) {
            const clipboardManager = require('./commands/clipboardManager');
            const responseText = clipboardManager.getResponse(commandName);

            if (responseText) {
                // Capture reference BEFORE delete
                const referenceId = message.reference ? message.reference.messageId : null;

                // Deletion Logic
                // 1. If it's the bot's own message, it can always delete it (Guild or DM).
                // 2. If it's someone else's message, bot needs MANAGE_MESSAGES permission in Guild to delete it.
                if (message.author.id === client.user.id) {
                    try { await message.delete(); } catch (e) { }
                } else if (message.guild && message.guild.me.permissionsIn(message.channel).has('MANAGE_MESSAGES')) {
                    try { await message.delete(); } catch (e) { }
                }

                // Logic:
                // 1. If user replied to a message, Bot copies that reply (Replies to the same message)
                // 2. If no reply, Bot just sends text (No ping, no mention)

                if (referenceId) {
                    try {
                        const repliedMsg = await message.channel.messages.fetch(referenceId);
                        if (repliedMsg) {
                            await repliedMsg.reply({ content: responseText, allowedMentions: { repliedUser: true } });
                        } else {
                            await message.channel.send(responseText);
                        }
                    } catch (e) {
                        // Fallback if message fetch failed
                        await message.channel.send(responseText);
                    }
                } else {
                    // No reply, just send text
                    await message.channel.send(responseText);
                }
                return;
            }
        }
        // --- CLIPBOARD MANAGER END ---

        if (!command) return;

        await command.execute(message, args, client);
    } catch (error) {
        console.error('Error in messageCreate:', error);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash] Unhandled Promise Rejection:\n', reason);
});

process.on('uncaughtException', (error, origin) => {
    console.error('[Anti-Crash] Uncaught Exception/Catch:\n', error, '\nOrigin:', origin);
});

process.on('uncaughtExceptionMonitor', (error, origin) => {
    console.error('[Anti-Crash] Uncaught Exception Monitor:\n', error, '\nOrigin:', origin);
});

if (!process.env.TOKEN) {
    console.error('Error: TOKEN not found in .env file');
    process.exit(1);
}

client.login(process.env.TOKEN).catch(error => {
    console.error('Failed to login:', error.message);
    process.exit(1);
});
