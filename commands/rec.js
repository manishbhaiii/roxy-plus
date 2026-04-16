const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    EndBehaviorType,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType
} = require('@discordjs/voice');

let OpusEncoder;
try {
    OpusEncoder = require('@discordjs/opus').OpusEncoder;
} catch (error) {
    const OpusScript = require('opusscript');
    OpusEncoder = class {
        constructor(rate, channels) {
            this.encoder = new OpusScript(rate, channels, OpusScript.Application.AUDIO);
        }
        decode(buffer) {
            return Buffer.from(this.encoder.decode(buffer));
        }
    };
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let ffmpegPath = 'ffmpeg';
try { ffmpegPath = require('ffmpeg-static'); } catch (e) {}

const RECORDINGS_DIR = path.join(__dirname, '..', 'dashboard', 'public', 'recordings');
const RECORDINGS_META = path.join(RECORDINGS_DIR, 'recordings.json');

const SILENCE_FRAME = Buffer.alloc(3840, 0);

function ensureDir() {
    if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

function loadMeta() {
    ensureDir();
    if (!fs.existsSync(RECORDINGS_META)) return [];
    try { return JSON.parse(fs.readFileSync(RECORDINGS_META, 'utf8')); } catch { return []; }
}

function saveMeta(data) {
    ensureDir();
    fs.writeFileSync(RECORDINGS_META, JSON.stringify(data, null, 2));
}

const activeSessions = new Map();
const playbackPlayers = new Map();
const playbackProcesses = new Map();

function mergeRawToMp3(tracks, outputPath) {
    return new Promise((resolve, reject) => {
        if (tracks.length === 0) return reject(new Error('No tracks to merge'));

        const inputArgs = [];
        tracks.forEach(t => {
            inputArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', t.pcmPath);
        });

        let args;
        if (tracks.length === 1) {
            args = ['-y', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', tracks[0].pcmPath, '-c:a', 'libmp3lame', '-b:a', '192k', outputPath];
        } else {
            args = [
                '-y', ...inputArgs,
                '-filter_complex', `amix=inputs=${tracks.length}:duration=longest:dropout_transition=2:normalize=0`,
                '-c:a', 'libmp3lame', '-b:a', '192k',
                outputPath
            ];
        }

        const proc = spawn(ffmpegPath, args);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed ' + code)));
        proc.on('error', reject);
    });
}

// ---- DASHBOARD HELPERS ----
async function joinTargetVC(client, guildId, channelId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("Guild not found");
    const connection = joinVoiceChannel({
        channelId, guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false, selfMute: false
    });
    // Wait shorter time, prevent extreme hangs
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 4000);
    } catch(e) {
        // Disregard strict state timeout if connection object is present
        // since often it is connected but DJS missed the state update packet
    }
    return connection;
}

async function startRecordingDirect(client, guildId, channelId, authorStr) {
    if (activeSessions.has(guildId)) throw new Error('Recording already in progress');
    
    let connection = getVoiceConnection(guildId);
    let g = client.guilds.cache.get(guildId);
    let c = g ? g.channels.cache.get(channelId) : null;

    if (!connection && c) {
        connection = await joinTargetVC(client, guildId, c.id);
    } else if (!connection) {
        throw new Error("Bot is not in VC and channelId is missing.");
    }
    
    if (!c) {
        // Find channel looking at connection
        const member = g.members.cache.get(client.user.id);
        if (member && member.voice.channel) c = member.voice.channel;
    }

    ensureDir();
    const sessionId = Date.now().toString();
    const sessionDir = path.join(RECORDINGS_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const receiver = connection.receiver;
    const recordingStartTime = Date.now();
    const userStreams = new Map();

    function getOrCreateUser(userId) {
        if (userStreams.has(userId)) return userStreams.get(userId);
        const pcmPath = path.join(sessionDir, `${userId}.pcm`);
        const writeStream = fs.createWriteStream(pcmPath);
        const encoder = new OpusEncoder(48000, 2);

        const elapsed = Date.now() - recordingStartTime;
        const padFrames = Math.floor(elapsed / 20);
        for (let i = 0; i < padFrames; i++) writeStream.write(SILENCE_FRAME);

        const userData = { pcmPath, writeStream, encoder, silenceInterval: null };
        userStreams.set(userId, userData);
        return userData;
    }

    function beginSilence(userId) {
        const u = userStreams.get(userId);
        if (!u || u.silenceInterval) return;
        u.silenceInterval = setInterval(() => {
            if (u.writeStream.writable) u.writeStream.write(SILENCE_FRAME);
        }, 20);
    }

    function endSilence(userId) {
        const u = userStreams.get(userId);
        if (!u || !u.silenceInterval) return;
        clearInterval(u.silenceInterval);
        u.silenceInterval = null;
    }

    receiver.speaking.on('start', (userId) => {
        const userData = getOrCreateUser(userId);
        endSilence(userId);

        const opusStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 200 }
        });

        opusStream.on('data', (chunk) => {
            try {
                const pcm = userData.encoder.decode(chunk);
                if (userData.writeStream.writable) userData.writeStream.write(pcm);
            } catch (e) {}
        });

        opusStream.on('end', () => beginSilence(userId));
        opusStream.on('error', () => {});
    });

    activeSessions.set(guildId, {
        sessionId, sessionDir, 
        channelId: c ? c.id : '',
        channelName: c ? c.name : 'Unknown',
        guildId, guildName: g ? g.name : 'Unknown',
        startedAt: new Date().toISOString(),
        recordingStartTime,
        startedBy: authorStr || 'System',
        connection, userStreams
    });
}

async function stopRecordingDirect(client, guildId) {
    const session = activeSessions.get(guildId);
    if (!session) throw new Error("No active recording in this server");
    activeSessions.delete(guildId);

    const durationMs = Date.now() - session.recordingStartTime;
    for (const [userId, userData] of session.userStreams) {
        if (userData.silenceInterval) { clearInterval(userData.silenceInterval); userData.silenceInterval = null; }
        try { userData.writeStream.end(); } catch (e) {}
    }

    await new Promise(r => setTimeout(r, 2000)); // wait for streams to close

    const tracks = [];
    for (const [userId, userData] of session.userStreams) {
        if (fs.existsSync(userData.pcmPath)) {
            const stat = fs.statSync(userData.pcmPath);
            if (stat.size > 0) tracks.push({ userId, pcmPath: userData.pcmPath });
        }
    }

    if (tracks.length === 0) {
        try { fs.rmSync(session.sessionDir, { recursive: true, force: true }); } catch (e) {}
        throw new Error("Recording stopped but no audio captured");
    }

    // Save as Server + Channel + timestamp .mp3
    const safeChannelName = session.channelName.replace(/[^a-z0-9]/gi, '_');
    const safeGuildName = session.guildName.replace(/[^a-z0-9]/gi, '_');
    const filename = `${safeGuildName}_${safeChannelName}_${session.sessionId}.mp3`;
    const outputPath = path.join(RECORDINGS_DIR, filename);

    try {
        await mergeRawToMp3(tracks, outputPath);
    } catch (e) {
        throw e;
    }

    for (const [userId, userData] of session.userStreams) {
        try { if (fs.existsSync(userData.pcmPath)) fs.unlinkSync(userData.pcmPath); } catch(e){}
    }
    try { fs.rmSync(session.sessionDir, { recursive: true, force: true }); } catch (e) {}

    const meta = loadMeta();
    const fileStat = await fs.promises.stat(outputPath);
    const durationSec = Math.round(durationMs / 1000);
    const maxNum = meta.reduce((acc, curr) => Math.max(acc, curr.number || 0), 0);

    meta.push({
        number: maxNum + 1,
        sessionId: session.sessionId,
        filename: filename,
        channel: session.channelName,
        guild: session.guildName,
        guildId: session.guildId,
        startedAt: session.startedAt,
        duration: durationSec,
        startedBy: session.startedBy,
        fileSize: fileStat.size
    });
    saveMeta(meta);
}

async function playRecordingDirect(client, guildId, filename) {
    const filePath = path.join(RECORDINGS_DIR, filename);
    if (!fs.existsSync(filePath)) throw new Error("File not found");

    let connection = getVoiceConnection(guildId);
    if (!connection) throw new Error("Bot must be in the voice channel first.");
    
    if (playbackPlayers.has(guildId)) {
        try { playbackPlayers.get(guildId).stop(); } catch(e) {}
    }
    if (playbackProcesses.has(guildId)) {
        try { playbackProcesses.get(guildId).kill(); } catch(e) {}
    }

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    playbackPlayers.set(guildId, player);
    connection.subscribe(player);

    const resource = createAudioResource(filePath, { inlineVolume: true });
    resource.volume.setVolume(1);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        playbackPlayers.delete(guildId);
    });
}

function stopPlaybackDirect(guildId) {
    if (playbackPlayers.has(guildId)) {
        try { playbackPlayers.get(guildId).stop(); } catch(e) {}
        playbackPlayers.delete(guildId);
    }
}

function deleteRecordingDirect(filename) {
    const meta = loadMeta();
    const idx = meta.findIndex(r => r.filename === filename);
    if (idx !== -1) {
        meta.splice(idx, 1);
        saveMeta(meta);
    }
    const filePath = path.join(RECORDINGS_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = {
    name: 'rec',
    category: 'Utility',
    description: 'Record all members audio in VC. Usage: !rec [stop]',
    async execute(message, args, client) {
        if (!message.guild) return;
        const sub = (args[0] || '').toLowerCase();
        
        if (sub === 'stop') {
            try {
                const session = activeSessions.get(message.guild.id);
                if (!session) return;
                await stopRecordingDirect(client, message.guild.id);
                message.channel.send('ok');
            } catch(e) {}
            return;
        }

        // !rec Start logic
        if (activeSessions.has(message.guild.id)) return;
        
        let targetChannel = null;
        
        // Check if author is already in VC
        const member = message.guild.members.cache.get(message.author.id);
        if (member && member.voice && member.voice.channel) {
            targetChannel = member.voice.channel;
        }

        if (targetChannel) {
            try {
                await startRecordingDirect(client, message.guild.id, targetChannel.id, message.author.tag);
                message.channel.send('ok');
            } catch(e) {}
        } else {
            // Not in VC, ask for ID
            const filter = m => m.author.id === message.author.id;
            const prompt = await message.channel.send('I am not in any voice channel pls send voice channel id');
            
            try {
                const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
                const ans = collected.first().content.trim();
                const vChannel = message.guild.channels.cache.get(ans);
                
                if (vChannel && vChannel.isVoice()) {
                    await startRecordingDirect(client, message.guild.id, vChannel.id, message.author.tag);
                    message.channel.send('ok');
                }
            } catch (e) {}
        }
    },
    activeSessions,
    playbackPlayers,
    playbackProcesses,
    loadMeta,
    joinTargetVC,
    startRecordingDirect,
    stopRecordingDirect,
    playRecordingDirect,
    stopPlaybackDirect,
    deleteRecordingDirect
};
