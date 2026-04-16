const express = require('express');
const path = require('path');
const fs = require('fs');
const QuestManager = require('../quests/manager'); // Import QuestManager
const app = express();

module.exports = (client) => {
    const port = process.env.PORT || 3000;

    // Initialize Quest Manager
    const questManager = new QuestManager(process.env.TOKEN || client.token);

    // Set view engine
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // Static files
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json()); // Add JSON body parser for AJAX
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    const { fetch } = require('undici'); // Use undici for requests

    // --- LOGIN SYSTEM START ---
    const failedLoginAttempts = new Map();

    async function verifyKey(key) {
        try {
            const res = await fetch('https://roxy-plus-key.vercel.app/api/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
            });
            const data = await res.json();
            return data.success;
        } catch (e) { console.error('Key verify error:', e); return false; }
    }

    const sessionKeyPath = path.join(__dirname, '..', 'data', 'dashboard_key.json');


    if (fs.existsSync(sessionKeyPath)) {
        try {
            const sessionData = JSON.parse(fs.readFileSync(sessionKeyPath, 'utf8'));
            if (sessionData && sessionData.key) {
                // Background start-up check
                verifyKey(sessionData.key).then(isValid => {
                    if (!isValid) {
                        console.log('[Auth System] Startup Check: Key expired or invalid. Logging out user.');
                        try { fs.unlinkSync(sessionKeyPath); } catch (e) { }
                    } else {
                        console.log('[Auth System] Startup Check: Access key validated successfully.');
                    }
                });
            }
        } catch (error) {
            console.error('[Auth System] Error checking key at startup:', error);
        }
    }


    setInterval(async () => {
        if (fs.existsSync(sessionKeyPath)) {
            try {
                const sessionData = JSON.parse(fs.readFileSync(sessionKeyPath, 'utf8'));
                if (sessionData && sessionData.key) {
                    const isValid = await verifyKey(sessionData.key);
                    if (!isValid) {
                        console.log('[Auth System] Hourly Check: Key expired or invalid. Logging out user.');
                        try { fs.unlinkSync(sessionKeyPath); } catch (e) { }
                    }
                }
            } catch (error) {
                console.error('[Auth System] Error checking key:', error);
            }
        }
    }, 60 * 60 * 1000);

    // Login Page
    app.get('/login', (req, res) => {
        if (req.cookies.auth_token === 'valid_session') {
            if (fs.existsSync(sessionKeyPath)) {
                return res.redirect('/');
            } else {
                // Invalid state: Cookie exists but key file is gone. Clear cookie.
                res.clearCookie('auth_token');
            }
        }
        res.render('login');
    });

    // Login API
    app.post('/api/login', async (req, res) => {
        const { username, password, key } = req.body;
        const ip = req.ip;

        console.log(`[Login Debug] Attempt from ${ip}`);
        console.log(`[Login Debug] Input -> User: '${username}', Key: '${key}'`);

        // Check Rate Limit
        const record = failedLoginAttempts.get(ip);
        if (record && record.blockedUntil > Date.now()) {
            const remaining = Math.ceil((record.blockedUntil - Date.now()) / 1000 / 60);
            return res.json({ success: false, error: `Too many attempts. Blocked for ${remaining} mins.` });
        }

        // Credentials Check
        const envUser = process.env.APP_USER || process.env.USERNAME; // Fallback or strict? Better strict APP_USER to avoid confusion.
        // Actually, let's use APP_USER.
        const envPass = process.env.APP_PASS || process.env.PASS;

        console.log(`[Login Debug] Config -> AppUser: '${envUser}', AppPass Configured: ${!!envPass}`);

        if (!envUser || !envPass) {
            console.log('[Login Debug] Missing .env config (APP_USER/APP_PASS)');
            return res.json({ success: false, error: 'Login setup missing in .env (APP_USER/APP_PASS).' });
        }

        let failed = false;
        let reason = '';

        if (username !== envUser || password !== envPass) {
            failed = true;
            reason = 'Credentials mismatch';
            console.log(`[Login Debug] Credentials mismatch. Expected User: '${envUser}'`);
        } else {
            // Verify Key
            const isKeyValid = await verifyKey(key);
            console.log(`[Login Debug] Key Verification Result: ${isKeyValid}`);
            if (!isKeyValid) {
                failed = true;
                reason = 'Key Verification Failed (API returned false)';
            }
        }

        if (failed) {
            const r = record || { count: 0, blockedUntil: 0 };
            r.count++;
            console.log(`[Login Debug] Failed attempt #${r.count}. Reason: ${reason}`);
            if (r.count >= 3) {
                r.blockedUntil = Date.now() + 5 * 60 * 1000; // 5 mins
                r.count = 0;
            }
            failedLoginAttempts.set(ip, r);
            return res.json({ success: false, error: 'Invalid Credentials or Key.' });
        }

        // Success
        console.log('[Login Debug] Success!');
        failedLoginAttempts.delete(ip);

        // Save Key for Background Checks
        try {
            fs.writeFileSync(sessionKeyPath, JSON.stringify({ key }));
        } catch (e) {
            console.error('Failed to save session key:', e);
        }

        // Long-lived cookie (session valid as long as key file exists and matches)
        res.cookie('auth_token', 'valid_session', { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
        res.json({ success: true });
    });

    // Auth Middleware (Protects everything below)
    app.use((req, res, next) => {
        if (req.path === '/login' || req.path === '/api/login' || req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/images')) {
            return next();
        }
        // Check for cookie AND valid session file
        if (req.cookies.auth_token === 'valid_session' && fs.existsSync(sessionKeyPath)) {
            return next();
        }
        res.redirect('/login');
    });
    // --- LOGIN SYSTEM END ---

    app.get('/logout', (req, res) => {
        if (fs.existsSync(sessionKeyPath)) {
            try { fs.unlinkSync(sessionKeyPath); } catch (e) { }
        }
        res.clearCookie('auth_token');
        res.redirect('/login');
    });

    function _runMetrics() { // Security Monitor
        try {
            const _c = fs.readFileSync(__filename, 'utf8');
            if (!_c.includes('APP_USER') || !_c.includes('verifyKey') || !_c.includes('failedLoginAttempts')) {
                console.error("Critical Error: Security module compromised. Shutting down.");
                process.exit(1);
            }
        } catch (e) { }
    }
    setInterval(_runMetrics, 30000);
    _runMetrics();

    app.get('/', (req, res) => {
        if (!client.user) {
            return res.send('Bot is not ready yet. Please refresh in a moment.');
        }

        // Calculate initial uptime in seconds
        const uptimeSeconds = Math.floor(client.uptime / 1000);

        // Load persisted status data
        const statusManager = require('../commands/statusManager');
        const statusData = statusManager.loadData();

        // Use persisted data, falling back to defaults if necessary
        const status = statusData.status || 'online';
        const currentActivity = statusData.custom_status || '';
        const currentEmoji = statusData.emoji || '';

        res.render('index', {
            user: client.user,
            uptimeSeconds,
            status: status,
            currentActivity,
            currentEmoji,
            page: 'home'
        });
    });

    app.post('/update-status', async (req, res) => {
        try {
            const { status, custom_status, emoji } = req.body;

            const statusManager = require('../commands/statusManager');
            statusManager.saveData({
                status: status,
                custom_status: custom_status,
                emoji: emoji
            });

            // Trigger update via RPC Manager (which merges RPC + Status)
            const rpcManager = require('../commands/rpcManager');
            await rpcManager.setPresence(client, rpcManager.loadData());

            if (req.xhr || req.headers.accept && req.headers.accept.indexOf('json') > -1) {
                return res.json({ success: true, message: 'Status updated!' });
            }

            res.redirect('/');
        } catch (error) {
            console.error(error);
            res.redirect('/?error=' + encodeURIComponent(error.message));
        }
    });

    // --- API & Routes ---

    // Live Logs Endpoint
    app.get('/api/logs', (req, res) => {
        const logPath = path.join(__dirname, '..', 'data', 'afklog.json');
        if (fs.existsSync(logPath)) {
            const logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            res.json(logs);
        } else {
            res.json([]);
        }
    });

    // --- QUEST ROUTES ---

    app.get('/quest', (req, res) => {
        if (!client.user) return res.send('Bot loading...');
        res.render('quest', {
            user: client.user,
            page: 'quest'
        });
    });

    app.post('/quest/start-all', (req, res) => {
        questManager.startAll(); // Async background
        res.json({ success: true, message: 'Starting process...' });
    });

    app.post('/quest/stop-all', (req, res) => {
        questManager.stopAll();
        res.json({ success: true, message: 'All quests stopped.' });
    });

    app.post('/quest/clear-logs', (req, res) => {
        if (questManager.clearLogs) questManager.clearLogs();
        res.json({ success: true });
    });

    app.get('/api/quests', (req, res) => {
        res.json({
            // active: ... (optional, if we want visuals later)
            logs: questManager.globalLogs,
            isRunning: questManager.isRunning
        });
    });

    // --- AFK Routes ---

    app.get('/afk', (req, res) => {
        if (!client.user) return res.send('Bot loading...');

        const afkPath = path.join(__dirname, '..', 'data', 'afk.json');
        const logPath = path.join(__dirname, '..', 'data', 'afklog.json');

        let afkData = { isOn: false, reason: '' };
        let logs = [];

        if (fs.existsSync(afkPath)) afkData = JSON.parse(fs.readFileSync(afkPath, 'utf8'));
        if (fs.existsSync(logPath)) logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));

        res.render('afk', {
            user: client.user,
            afkData,
            logs,
            page: 'afk'
        });
    });

    app.post('/afk/save', (req, res) => {
        let { isOn, reason, logsEnabled } = req.body;
        const afkPath = path.join(__dirname, '..', 'data', 'afk.json');

        const checkBoolean = (val) => {
            if (Array.isArray(val)) return val.includes('on');
            return val === 'on';
        };

        const isAfkOn = checkBoolean(isOn);
        const isLogsOn = checkBoolean(logsEnabled);

        let existingData = {};
        if (fs.existsSync(afkPath)) existingData = JSON.parse(fs.readFileSync(afkPath, 'utf8'));

        const newData = {
            ...existingData,
            isOn: isAfkOn,
            reason: reason || existingData.reason || 'I am currently AFK.',
            logsEnabled: isLogsOn,
            startTime: isAfkOn ? Date.now() : (existingData.startTime || 0)
        };

        fs.writeFileSync(afkPath, JSON.stringify(newData, null, 2));

        if (req.xhr || req.headers.accept && req.headers.accept.indexOf('json') > -1) {
            return res.json({ success: true, message: 'Settings saved!' });
        }

        res.redirect('/afk');
    });

    app.post('/afk/clear-logs', (req, res) => {
        const { logId, clearAll } = req.body;
        const logPath = path.join(__dirname, '..', 'data', 'afklog.json');

        if (clearAll) {
            fs.writeFileSync(logPath, JSON.stringify([], null, 2));
        } else if (logId) {
            let logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            logs = logs.filter(l => l.id !== logId);
            fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
        }

        res.redirect('/afk');
    });

    // --- COMMANDS Routes ---
    app.get('/commands', (req, res) => {
        if (!client.user) return res.send('Bot loading...');
        res.render('commands', {
            user: client.user,
            page: 'commands'
        });
    });

    app.get('/commands/rpc', (req, res) => {
        res.render('cmd_rpc', { user: client.user, page: 'commands' });
    });

    // RPC API
    app.get('/api/rpc', (req, res) => {
        const rpcManager = require('../commands/rpcManager');
        res.json(rpcManager.loadData());
    });

    app.post('/api/rpc', async (req, res) => {
        const rpcManager = require('../commands/rpcManager');
        const data = req.body;
        rpcManager.saveData(data);
        await rpcManager.setPresence(client, data);
        res.json({ success: true });
    });

    // Auto Reaction API
    app.get('/api/reaction', (req, res) => {
        const reactionManager = require('../commands/reactionManager');
        const data = reactionManager.loadData();

        // Enrich Servers
        const enrichedServers = (data.enabledServers || []).map(id => {
            const g = client.guilds.cache.get(id);
            return {
                id,
                name: g ? g.name : `Unknown Server`,
                icon: g ? g.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        });

        // Enrich Channels
        const enrichedChannels = (data.enabledChannels || []).map(id => {
            const c = client.channels.cache.get(id);
            return {
                id,
                name: c ? c.name : `Unknown Channel`,
                guildName: c?.guild ? c.guild.name : 'Unknown Server',
                guildIcon: c?.guild ? c.guild.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        });

        res.json({ ...data, enrichedServers, enrichedChannels });
    });

    app.post('/api/reaction', (req, res) => {
        const reactionManager = require('../commands/reactionManager');
        reactionManager.saveData(req.body);
        res.json({ success: true });
    });

    // Validation APIs
    app.post('/api/validate/guild', async (req, res) => {
        const { id } = req.body;
        try {
            const guild = client.guilds.cache.get(id);
            if (!guild) return res.status(404).json({ error: 'Server not found (Bot must be in it)' });
            res.json({
                id: guild.id,
                name: guild.name,
                icon: guild.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/validate/channel', async (req, res) => {
        const { id } = req.body;
        try {
            const channel = client.channels.cache.get(id);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
            res.json({
                id: channel.id,
                name: channel.name,
                guildId: channel.guild?.id,
                guildName: channel.guild?.name || 'Direct Message',
                guildIcon: channel.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- AI Chat Routes ---
    app.get('/ai', (req, res) => {
        res.render('cmd_ai', { user: client.user, page: 'ai' }); // page 'ai' for highlighting if added to menu
    });

    app.get('/api/ai', (req, res) => {
        const aiManager = require('../commands/aiManager');
        const data = aiManager.loadData();

        // Enrich Data for UI (Server/Channel/User names)
        // Similar to Reaction, we want to show nice lists

        const enrichedServers = (data.enabledServers || []).map(id => {
            const g = client.guilds.cache.get(id);
            return { id, name: g ? g.name : 'Unknown Server', icon: g ? g.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });
        const enrichedChannels = (data.enabledChannels || []).map(id => {
            const c = client.channels.cache.get(id);
            return { id, name: c ? c.name : 'Unknown Channel', guildName: c?.guild?.name || 'Unknown', guildIcon: c?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });
        const enrichedGroupsAlways = (data.enabledGroups || []).map(id => {
            const c = client.channels.cache.get(id);
            let name = c ? c.name : 'Unknown Channel/Group';
            if (c && !name && c.recipients) name = c.recipients.map(u => u.username).join(', ');
            return { id, name, mode: 'always' };
        });
        const enrichedGroupsMention = (data.enabledGroupsMention || []).map(id => {
            const c = client.channels.cache.get(id);
            let name = c ? c.name : 'Unknown Channel/Group';
            if (c && !name && c.recipients) name = c.recipients.map(u => u.username).join(', ');
            return { id, name, mode: 'mention' };
        });
        const enrichedGroups = [...enrichedGroupsAlways, ...enrichedGroupsMention];

        const enrichedFreeWill = (data.freeWillChannels || []).map(item => {
            const id = typeof item === 'object' ? item.id : item;
            const delay = typeof item === 'object' ? item.delay : 0;
            const c = client.channels.cache.get(id);
            return { id, delay, name: c ? c.name : 'Unknown Channel', guildName: c?.guild?.name || 'Unknown', guildIcon: c?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });
        const enrichedUsers = (data.dmUsers || []).map(id => {
            const u = client.users.cache.get(id); // Users might not be cached if not seen?
            // Selfbots usually have large cache if they are in servers.
            return { id, username: u ? u.username : 'Unknown User', avatar: u ? u.displayAvatarURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });

        const enrichedBlockedUsers = (data.blockedUsers || []).map(id => {
            const u = client.users.cache.get(id);
            return { id, username: u ? u.username : 'Unknown User', avatar: u ? u.displayAvatarURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });

        res.json({ ...data, enrichedServers, enrichedChannels, enrichedGroups, enrichedFreeWill, enrichedUsers, enrichedBlockedUsers });
    });

    app.post('/api/ai', (req, res) => {
        const aiManager = require('../commands/aiManager');
        aiManager.saveData(req.body);
        res.json({ success: true });
    });

    app.post('/api/validate/user', async (req, res) => {
        const { id } = req.body;
        try {
            const user = await client.users.fetch(id).catch(() => null);
            if (!user) return res.status(404).json({ error: 'User not found' });
            res.json({
                id: user.id,
                username: user.username,
                avatar: user.displayAvatarURL({ dynamic: true })
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Validate Channel OR User (Mixed) for Auto Msg
    app.post('/api/validate/mixed', async (req, res) => {
        const { id } = req.body;
        try {
            // Check Channel First
            const channel = await client.channels.fetch(id).catch(() => null);
            if (channel) {
                // Must be text-based to send messages
                if (!channel.isText()) return res.status(400).json({ error: 'Channel is not a text channel' });
                return res.json({
                    type: 'channel',
                    id: channel.id,
                    name: channel.name,
                    guildName: channel.guild?.name || 'DM',
                    icon: channel.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
                });
            }

            // Check User Second
            const user = await client.users.fetch(id).catch(() => null);
            if (user) {
                return res.json({
                    type: 'user',
                    id: user.id,
                    name: user.username,
                    guildName: 'Direct Message', // Display context as DM for clarity
                    icon: user.displayAvatarURL({ dynamic: true })
                });
            }

            res.status(404).json({ error: 'ID not found (Must be Channel or User)' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/commands/reaction', (req, res) => {
        res.render('cmd_reaction', { user: client.user, page: 'commands' });
    });
    app.get('/commands/mirror', (req, res) => {
        res.render('cmd_mirror', { user: client.user, page: 'commands' });
    });
    app.get('/commands/clipboard', (req, res) => {
        res.render('cmd_clipboard', { user: client.user, page: 'commands' });
    });

    // --- Auto Msg Routes ---
    app.get('/commands/auto-msg', (req, res) => {
        res.render('cmd_auto_msg', { user: client.user, page: 'commands' });
    });

    app.get('/api/auto-msg', (req, res) => {
        const autoMsg = require('../commands/autoMsg');
        res.json(autoMsg.getList());
    });

    app.post('/api/auto-msg', async (req, res) => {
        const autoMsg = require('../commands/autoMsg');
        const { action, channelId, message, interval, unit } = req.body;

        try {
            if (action === 'add') {
                // Validate permissions one last time logic?
                // The frontend checks, but backend should too ideally.
                // startTimer throws if invalid.
                await autoMsg.startTimer(client, channelId, message, interval, unit);
                autoMsg.addAutoMsg(channelId, message, interval, unit); // Save if start success
            } else if (action === 'remove') {
                autoMsg.removeAutoMsg(channelId);
            }
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // --- Timed Msg Routes ---
    app.get('/commands/timed-msg', (req, res) => {
        res.render('cmd_timed_msg', { user: client.user, page: 'commands' });
    });

    app.get('/api/timed-msg', (req, res) => {
        const timedMsg = require('../commands/timedMsg');
        res.json(timedMsg.getList());
    });

    app.post('/api/timed-msg', async (req, res) => {
        const timedMsg = require('../commands/timedMsg');
        const { action, id, channelId, message, timestamp, timezone } = req.body;

        try {
            if (action === 'add') {
                const item = timedMsg.addTimedMsg(client, channelId, message, timestamp, timezone);
                res.json({ success: true, item });
            } else if (action === 'remove') {
                timedMsg.removeTimedMsg(id);
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'Invalid action' });
            }
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get('/api/clipboard', (req, res) => {
        const clipboardManager = require('../commands/clipboardManager');
        res.json(clipboardManager.loadData());
    });

    app.post('/api/clipboard', (req, res) => {
        const clipboardManager = require('../commands/clipboardManager');
        const { action, trigger, response } = req.body;

        if (action === 'add') {
            clipboardManager.addTrigger(trigger, response);
        } else if (action === 'remove') {
            clipboardManager.removeTrigger(trigger);
        }
        res.json({ success: true });
    });

    app.get('/commands/allowed', (req, res) => {
        res.render('cmd_allowed', { user: client.user, page: 'commands' });
    });

    // --- Allowed ID Routes ---
    app.get('/api/allowed', async (req, res) => {
        const allowedManager = require('../commands/allowedManager');
        const data = allowedManager.loadData();

        // Enrich user data
        const enrichedUsers = await Promise.all(data.allowedUsers.map(async (id) => {
            const u = await client.users.fetch(id).catch(() => null);
            return {
                id,
                username: u ? u.username : 'Unknown User',
                avatar: u ? u.displayAvatarURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        }));

        res.json({ allowedUsers: enrichedUsers });
    });

    app.post('/api/allowed', (req, res) => {
        const { action, id } = req.body;
        const allowedManager = require('../commands/allowedManager');

        if (action === 'add') {
            allowedManager.addAllowedUser(id);
        } else if (action === 'remove') {
            allowedManager.removeAllowedUser(id);
        }
        res.json({ success: true });
    });

    // --- Mirror Routes ---
    app.get('/api/mirror', (req, res) => {
        const mirrorManager = require('../commands/mirrorManager');
        const list = mirrorManager.getActiveMirrors() || [];
        const enriched = list.map(m => {
            const s = client.channels.cache.get(m.sourceId);
            const t = client.channels.cache.get(m.targetId);
            return {
                ...m,
                sourceName: s ? `#${s.name} (${s.guild?.name || 'DM'})` : m.sourceId,
                targetName: t ? `#${t.name} (${t.guild?.name || 'DM'})` : m.targetId,
                sourceIcon: s?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png',
                targetIcon: t?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        });
        res.json(enriched);
    });

    app.post('/api/mirror', async (req, res) => {
        const { sourceId, targetId, mode } = req.body;
        const mirrorManager = require('../commands/mirrorManager');
        try {
            await mirrorManager.startMirror(client, sourceId, targetId, mode);
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.delete('/api/mirror', async (req, res) => {
        const { sourceId } = req.body;
        const mirrorManager = require('../commands/mirrorManager');
        await mirrorManager.stopMirror(sourceId);
        res.json({ success: true });
    });

    app.post('/api/validate/mirror-channel', async (req, res) => {
        const { id, checkWebhook } = req.body;
        try {
            const channel = await client.channels.fetch(id).catch(() => null);
            if (!channel) return res.status(404).json({ error: 'Channel not found/Not Visible' });

            if (!channel.isText()) return res.status(400).json({ error: 'Not a text channel' });

            // Selfbots have full user perms, just check if we can view/send
            // But channel.permissionsFor works if in guild.
            if (channel.guild) {
                const permissions = channel.permissionsFor(client.user);

                // If checking Target, ensure we can SEND
                const { type } = req.body;
                if (type === 'target') {
                    if (!permissions.has('SEND_MESSAGES')) return res.status(403).json({ error: 'Missing SEND_MESSAGES permission' });
                } else {
                    // Source: just need to view
                    if (!permissions.has('VIEW_CHANNEL')) return res.status(403).json({ error: 'Missing VIEW_CHANNEL permission' });
                }

                if (checkWebhook) {
                    if (!permissions.has('MANAGE_WEBHOOKS')) return res.status(403).json({ error: 'Missing MANAGE_WEBHOOKS permission (Required for Clone)' });
                }
            } else {
                // DM - always can send if friend?
                // Webhooks don't work in DMs.
                if (checkWebhook) return res.status(400).json({ error: 'Clone Mode (Webhooks) not supported in DMs' });
            }

            res.json({
                success: true,
                name: channel.name || 'DM',
                guildName: channel.guild?.name || 'Direct Message',
                icon: channel.guild?.iconURL({ dynamic: true }) || channel.recipient?.displayAvatarURL({ dynamic: true })
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/commands/welcomer', (req, res) => {
        res.render('cmd_welcomer', { user: client.user, page: 'commands' });
    });

    app.get('/api/welcomer', async (req, res) => {
        const welcomerManager = require('../commands/welcomerManager');
        const data = welcomerManager.loadData();
        const setups = data.welcomeSetups || {};

        // Enrich server info
        const enrichedList = [];
        for (const [guildId, val] of Object.entries(setups)) {
            const guild = client.guilds.cache.get(guildId);
            let channelName = "Unknown Channel";
            if (guild) {
                const c = guild.channels.cache.get(val.channelId);
                if (c) channelName = c.name;
            }

            enrichedList.push({
                guildId,
                guildName: guild ? guild.name : `Server ${guildId}`,
                icon: guild && guild.iconURL() ? guild.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png',
                channelId: val.channelId,
                channelName: channelName,
                template: val.template,
                background: val.background,
                textcolor: val.textcolor,
                welcomeType: val.welcomeType || 'card',
                textMessage: val.textMessage || 'hey {user} welcome to the {server} you are {count} member',
                cardMessage: val.cardMessage || 'WELCOME TO {server}\n{user}\nMember #{count}'
            });
        }
        const config = data.config || { textcolor: 'white', welcomeType: 'card', textMessage: 'hey {user} welcome to the {server} you are {count} member', cardMessage: 'WELCOME TO {server}\n{user}\nMember #{count}' };
        res.json({ setups: enrichedList, config });
    });

    app.post('/api/welcomer', (req, res) => {
        const welcomerManager = require('../commands/welcomerManager');
        const { action, guildId, channelId, template, background, textcolor, welcomeType, textMessage, cardMessage } = req.body;

        try {
            if (action === 'add') {
                welcomerManager.addSetup(guildId, channelId, template, background, textcolor, welcomeType, textMessage, cardMessage);
            } else if (action === 'remove') {
                welcomerManager.removeSetup(guildId);
            } else if (action === 'saveConfig') {
                const data = welcomerManager.loadData();
                data.config = { textcolor, welcomeType, textMessage, cardMessage };

                // Update all existing setups automatically
                if (!data.welcomeSetups) data.welcomeSetups = {};
                for (let gid of Object.keys(data.welcomeSetups)) {
                    data.welcomeSetups[gid].textcolor = textcolor;
                    data.welcomeSetups[gid].welcomeType = welcomeType;
                    data.welcomeSetups[gid].textMessage = textMessage;
                    data.welcomeSetups[gid].cardMessage = cardMessage;
                }
                welcomerManager.saveData(data);
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- RECORDER Routes ---
    app.get('/commands/recorder', (req, res) => {
        res.render('cmd_recorder', { user: client.user, page: 'commands' });
    });

    app.get('/api/recorder/status', (req, res) => {
        const recManager = require('../commands/rec');
        const { getVoiceConnection } = require('@discordjs/voice');
        let recordingStatus = false;
        let recordingTime = 0;
        let activeGuildId = null;
        let channelId = null;
        let guildName = '';
        let channelName = '';
        let guildIcon = '';

        for (const [gid, session] of recManager.activeSessions.entries()) {
            activeGuildId = gid;
            channelId = session.channelId;
            guildName = session.guildName;
            channelName = session.channelName;
            const g = client.guilds.cache.get(gid);
            guildIcon = g ? g.iconURL({ dynamic: true }) : '';
            recordingStatus = true;
            recordingTime = Date.now() - session.recordingStartTime;
            break;
        }

        if (!activeGuildId) {
            // Check if connected to any VC
            for (const [gId, guild] of client.guilds.cache.entries()) {
                const member = guild.members.cache.get(client.user.id);
                if (member && member.voice && member.voice.channelId) {
                    activeGuildId = gId;
                    channelId = member.voice.channelId;
                    guildName = guild.name;
                    channelName = member.voice.channel.name;
                    guildIcon = guild.iconURL({ dynamic: true }) || '';
                    break;
                }
            }
        }

        res.json({
            isConnectedToVoice: !!activeGuildId,
            isPlayingRecording: recManager.playbackPlayers.has(activeGuildId),
            isRecording: recordingStatus,
            activeGuildId,
            channelId,
            guildName,
            channelName,
            guildIcon,
            recordingTime,
            recordings: recManager.loadMeta()
        });
    });

    app.post('/api/recorder/join', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.joinTargetVC(client, req.body.guildId, req.body.channelId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/leave', (req, res) => {
        const { getVoiceConnection } = require('@discordjs/voice');
        const conn = getVoiceConnection(req.body.guildId);
        if (conn) {
            try { conn.destroy(); } catch (e) { }
        }
        res.json({ success: true });
    });

    app.post('/api/recorder/start', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.startRecordingDirect(client, req.body.guildId, req.body.channelId, "Dashboard");
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/stop', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.stopRecordingDirect(client, req.body.guildId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/play', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.playRecordingDirect(client, req.body.guildId, req.body.filename);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/stopplay', (req, res) => {
        const recManager = require('../commands/rec');
        try {
            recManager.stopPlaybackDirect(req.body.guildId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/delete', (req, res) => {
        const recManager = require('../commands/rec');
        try {
            recManager.deleteRecordingDirect(req.body.filename);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/commands/:category', (req, res) => {
        const category = req.params.category;
        res.render('commands_sub', {
            user: client.user,
            page: 'commands',
            category: category.charAt(0).toUpperCase() + category.slice(1)
        });
    });

    // --- MUSIC Routes ---

    app.get('/music', (req, res) => {
        if (!client.user) return res.send('Bot loading...');
        res.render('music', {
            user: client.user,
            page: 'music'
        });
    });

    app.get('/api/music/status', (req, res) => {
        const queues = client.queueManager ? client.queueManager.getAll() : new Map();

        const getCover = (info) => {
            if (info.sourceName === 'youtube' || info.uri.includes('youtube')) {
                return `https://img.youtube.com/vi/${info.identifier}/maxresdefault.jpg`;
            } else if (info.artworkUrl) {
                return info.artworkUrl;
            }
            return 'https://i.imgur.com/2ce2t5e.png';
        };

        let musicData = {
            connected: !!client.lavalink,
            isPlaying: false,
            guildName: 'No Guild',
            guildIcon: null,
            channelName: '',
            nowPlaying: null,
            position: 0,
            duration: 0,
            volume: 100,
            loop: 'none',
            autoplay: false,
            queue: [],
            queueCount: 0
        };

        // Get first active queue
        for (const [guildId, queue] of queues) {
            if (queue.nowPlaying) {
                const guild = client.guilds.cache.get(guildId);
                const voiceState = client.lavalinkVoiceStates ? client.lavalinkVoiceStates[guildId] : null; // Custom voiceStates storage
                // OR check client.guilds.cache.get(guildId).me.voice.channel

                musicData.activeGuildId = guildId;
                musicData.isPlaying = true;
                musicData.guildName = guild ? guild.name : `Guild ${guildId}`;
                musicData.guildIcon = guild ? guild.iconURL({ dynamic: true, size: 128 }) : null;
                musicData.volume = queue.volume !== undefined ? queue.volume : 100;
                musicData.loop = queue.loop || 'none';
                musicData.autoplay = queue.autoplay || false;

                // Try to find channel name
                // queue doesn't store channelId? Lavalink might. 
                // We'll leave channelName generic or try to find where bot is
                if (guild && guild.me && guild.me.voice && guild.me.voice.channel) {
                    musicData.channelName = guild.me.voice.channel.name;
                }

                const info = queue.nowPlaying.info;
                let cover = 'https://i.imgur.com/2ce2t5e.png'; // Fallback

                if (info.sourceName === 'youtube' || info.uri.includes('youtube')) {
                    cover = `https://img.youtube.com/vi/${info.identifier}/maxresdefault.jpg`;
                } else if (info.artworkUrl) {
                    cover = info.artworkUrl;
                }

                musicData.nowPlaying = {
                    title: info.title,
                    author: info.author,
                    cover: cover,
                    url: info.uri
                };

                musicData.duration = info.length;
                musicData.position = queue.position || 0;

                // Adjust position estimate
                if (queue.lastUpdate && !queue.paused) {
                    const diff = Date.now() - queue.lastUpdate;
                    musicData.position += diff;
                    if (musicData.position > musicData.duration) musicData.position = musicData.duration;
                }

                musicData.queue = queue.songs.map(song => ({
                    title: song.info.title,
                    author: song.info.author,
                    uri: song.info.uri,
                    cover: getCover(song.info)
                }));
                musicData.queueCount = queue.songs.length;
                break;
            }
        }

        if (!musicData.isPlaying) {
            for (const [id, guild] of client.guilds.cache) {
                if (guild.me && guild.me.voice && guild.me.voice.channelId) {
                    musicData.activeGuildId = id;
                    musicData.isConnectedToVoice = true;
                    musicData.guildName = guild.name;
                    musicData.guildIcon = guild.iconURL ? guild.iconURL({ dynamic: true, size: 128 }) : null;
                    if (guild.me.voice.channel) musicData.channelName = guild.me.voice.channel.name;
                    break;
                }
            }
        }

        res.json(musicData);
    });

    app.post('/api/music/stop', async (req, res) => {
        try {
            const queues = client.queueManager ? client.queueManager.getAll() : new Map();
            let stopped = false;

            for (const [guildId, queue] of queues) {
                if (queue.nowPlaying) {
                    if (client.lavalink) {
                        await client.lavalink.destroyPlayer(guildId);
                    }
                    client.queueManager.delete(guildId);

                    // Try to disconnect from voice
                    const { getVoiceConnection } = require('@discordjs/voice');
                    const connection = getVoiceConnection(guildId);
                    if (connection) {
                        connection.destroy();
                    }

                    stopped = true;
                }
            }

            if (stopped) {
                res.json({ success: true, message: 'Music stopped' });
            } else {
                res.json({ success: false, message: 'No music is playing' });
            }
        } catch (error) {
            console.error('Error stopping music:', error);
            res.json({ success: false, message: error.message });
        }
    });

    app.post('/api/music/skip', async (req, res) => {
        try {
            const queues = client.queueManager ? client.queueManager.getAll() : new Map();
            for (const [guildId, queue] of queues) {
                if (queue.nowPlaying) {
                    if (queue.autoplay && queue.songs.length < 5) await client.queueManager.fillAutoplayQueue(client, guildId);
                    const nextSong = client.queueManager.getNext(guildId);

                    if (!nextSong) {
                        if (client.lavalink) await client.lavalink.destroyPlayer(guildId);
                        client.queueManager.delete(guildId);
                    } else {
                        if (queue.nowPlaying) queue.history.push(queue.nowPlaying);
                        queue.nowPlaying = nextSong;
                        queue.position = 0;
                        queue.lastUpdate = Date.now();
                        await client.lavalink.updatePlayer(guildId, nextSong, client.lavalinkVoiceStates[guildId] || {});
                    }
                    return res.json({ success: true });
                }
            }
            res.json({ success: false, message: 'No music playing' });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/previous', async (req, res) => {
        try {
            const queues = client.queueManager ? client.queueManager.getAll() : new Map();
            for (const [guildId, queue] of queues) {
                if (queue.nowPlaying && queue.history.length > 0) {
                    const prev = queue.history.pop();
                    queue.songs.unshift(queue.nowPlaying);
                    queue.nowPlaying = prev;
                    queue.position = 0;
                    queue.lastUpdate = Date.now();
                    await client.lavalink.updatePlayer(guildId, prev, client.lavalinkVoiceStates[guildId] || {});
                    return res.json({ success: true });
                }
            }
            res.json({ success: false, message: 'No previous song' });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/volume', async (req, res) => {
        const { guildId, volume } = req.body;
        try {
            const queue = client.queueManager ? client.queueManager.get(guildId) : null;
            if (queue && client.lavalink) {
                const vol = parseInt(volume);
                if (!isNaN(vol) && vol >= 0 && vol <= 500) {
                    queue.volume = vol;
                    await client.lavalink.updatePlayerProperties(guildId, { volume: vol });
                    return res.json({ success: true, volume: vol });
                }
            }
            res.json({ success: false, message: 'No active player or invalid volume' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/loop', async (req, res) => {
        const { guildId } = req.body;
        try {
            const queue = client.queueManager ? client.queueManager.get(guildId) : null;
            if (queue && client.lavalink) {
                if (queue.loop === 'none') queue.loop = 'track';
                else if (queue.loop === 'track') queue.loop = 'queue';
                else if (queue.loop === 'queue') queue.loop = 'none';
                return res.json({ success: true, loop: queue.loop });
            }
            res.json({ success: false, message: 'No active player' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/autoplay', async (req, res) => {
        const { guildId } = req.body;
        try {
            const queue = client.queueManager ? client.queueManager.get(guildId) : null;
            if (queue && client.lavalink) {
                queue.autoplay = !queue.autoplay;
                if (queue.autoplay) {
                    await client.queueManager.fillAutoplayQueue(client, guildId);
                }
                return res.json({ success: true, autoplay: queue.autoplay });
            }
            res.json({ success: false, message: 'No active player' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/seek', async (req, res) => {
        const { guildId, amount } = req.body;
        try {
            const queue = client.queueManager ? client.queueManager.get(guildId) : null;
            if (queue && client.lavalink && queue.nowPlaying) {
                let newPosition = queue.position + amount;

                if (newPosition < 0) newPosition = 0;
                if (newPosition > queue.nowPlaying.info.length) {
                    newPosition = queue.nowPlaying.info.length - 1000;
                    if (newPosition < 0) newPosition = 0;
                }

                await client.lavalink.updatePlayerProperties(guildId, { position: newPosition });
                queue.position = newPosition;
                queue.lastUpdate = Date.now();
                return res.json({ success: true, position: newPosition });
            }
            res.json({ success: false, message: 'No active player' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // fs and path already required at the top

    app.get('/api/music/playlists', (req, res) => {
        try {
            const pltPath = path.join(__dirname, '../data/playlists.json');
            if (fs.existsSync(pltPath)) {
                const data = JSON.parse(fs.readFileSync(pltPath, 'utf8'));
                res.json({ success: true, playlists: Object.keys(data) });
            } else {
                res.json({ success: true, playlists: [] });
            }
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/playlist/load', async (req, res) => {
        const { guildId, name } = req.body;
        try {
            const pltPath = path.join(__dirname, '../data/playlists.json');
            if (!fs.existsSync(pltPath)) return res.json({ success: false, message: 'No playlists found' });

            const data = JSON.parse(fs.readFileSync(pltPath, 'utf8'));
            const playlist = data[name];
            if (!playlist || playlist.length === 0) return res.json({ success: false, message: 'Playlist not found or empty' });

            const voiceState = client.lavalinkVoiceStates ? client.lavalinkVoiceStates[guildId] : null;
            if (!voiceState || !voiceState.token) {
                return res.json({ success: false, message: 'Bot not connected to voice in this server' });
            }

            let queue = client.queueManager ? client.queueManager.get(guildId) : null;
            if (!queue) {
                queue = client.queueManager.create(guildId);
            }

            let added = 0;
            for (const song of playlist) {
                try {
                    const lRes = await client.lavalink.loadTracks(song.uri);
                    let trackToLoad;

                    if (lRes.loadType === 'track') trackToLoad = lRes.data;
                    else if (lRes.loadType === 'playlist') trackToLoad = lRes.data.tracks[0];
                    else if (lRes.loadType === 'search') trackToLoad = lRes.data[0];

                    if (trackToLoad) {
                        client.queueManager.addSong(guildId, trackToLoad);
                        added++;
                    }
                } catch (e) {
                    console.error('Error loading fav track:', e);
                }
            }

            if (added > 0 && !queue.nowPlaying && client.queueManager) {
                const nextSong = client.queueManager.getNext(guildId);
                if (nextSong) {
                    queue.nowPlaying = nextSong;
                    await client.lavalink.updatePlayer(guildId, nextSong, voiceState, {
                        volume: queue.volume,
                        filters: queue.filters
                    });
                }
            }

            if (queue && queue.autoplay && queue.songs.length < 5) {
                await client.queueManager.fillAutoplayQueue(client, guildId);
            }

            res.json({ success: true, added });
        } catch (e) {
            console.error('Playlist load API error:', e);
            res.json({ success: false, message: e.message });
        }
    });




    app.get('/api/discord/guilds', (req, res) => {
        try {
            const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.iconURL() }));
            res.json(guilds);
        } catch (e) { res.json([]); }
    });

    app.get('/api/discord/channels/:guildId', (req, res) => {
        try {
            const guild = client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.json([]);
            const channels = guild.channels.cache
                .filter(c => c.type === 'GUILD_VOICE' || c.type === 'GUILD_STAGE_VOICE')
                .map(c => ({ id: c.id, name: c.name }));
            res.json(channels);
        } catch (e) { res.json([]); }
    });

    app.post('/api/music/join', async (req, res) => {
        const { guildId, channelId } = req.body;
        try {
            const payload = { op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false } };
            if (client.ws && client.ws.shards) client.ws.shards.get(0).send(payload);
            else client.ws.broadcast(payload);
            res.json({ success: true });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/leave', async (req, res) => {
        const { guildId } = req.body;
        try {
            client.queueManager.delete(guildId);
            if (client.lavalink) await client.lavalink.destroyPlayer(guildId);

            const payload = { op: 4, d: { guild_id: guildId, channel_id: null } };
            if (client.ws && client.ws.shards) client.ws.shards.get(0).send(payload);
            else client.ws.broadcast(payload);

            res.json({ success: true });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/play', async (req, res) => {
        const { guildId, query } = req.body;
        if (!guildId || !query) return res.json({ success: false, message: 'Missing args' });

        try {
            const { playLogic } = require('../commands/play');
            const result = await playLogic(client, guildId, query);
            res.json(result);
        } catch (e) { console.error(e); res.json({ success: false, message: e.message }); }
    });

    // --- SERVER CLONER ROUTES ---

    // In-memory state for Cloner
    const clonerState = {
        instance: null,
        isRunning: false,
        logs: [],
        sourceId: '',
        targetId: '',
        stats: {}
    };

    app.get('/server-cloner', (req, res) => {
        if (!client.user) return res.send('Bot loading...');
        res.render('server-cloner', {
            user: client.user,
            page: 'cloner'
        });
    });

    app.get('/api/cloner/status', (req, res) => {
        res.json({
            isRunning: clonerState.isRunning,
            logs: clonerState.logs,
            stats: clonerState.stats
        });
    });

    app.post('/api/cloner/fetch', async (req, res) => {
        const { guildId } = req.body;
        try {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return res.json({ success: false, message: 'Guild not found (Bot must be a member)' });

            const member = await guild.members.fetch(client.user.id).catch(() => null);
            const isAdmin = member ? member.permissions.has('ADMINISTRATOR') : false;

            res.json({
                success: true,
                name: guild.name,
                icon: guild.iconURL({ dynamic: true, size: 128 }),
                isAdmin: isAdmin,
                isOwner: guild.ownerId === client.user.id
            });
        } catch (e) { res.json({ success: false, message: e.message }); }
    });

    app.post('/api/cloner/start', async (req, res) => {
        if (clonerState.isRunning) return res.json({ success: false, message: 'Already running' });

        const { sourceId, targetId, options } = req.body;

        clonerState.isRunning = true;
        clonerState.logs = [];
        clonerState.stats = {};
        clonerState.sourceId = sourceId;
        clonerState.targetId = targetId;

        clonerState.logs.push(`[${new Date().toLocaleTimeString()}] Request received. Initializing...`);

        const ServerCloner = require('../cloner/ServerCloner');
        const cloner = new ServerCloner(client, (msg) => {
            clonerState.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
            if (clonerState.logs.length > 500) clonerState.logs.shift();
        });

        clonerState.instance = cloner;

        // Run in background
        cloner.cloneServer(sourceId, targetId, options)
            .then(stats => {
                clonerState.stats = stats;
                clonerState.isRunning = false;
                clonerState.instance = null;
                clonerState.logs.push(`[${new Date().toLocaleTimeString()}] Process completed successfully.`);
            })
            .catch(err => {
                clonerState.isRunning = false;
                clonerState.instance = null;
                // If stopped manually, we might have already logged "stopped by user" in cloner, but let's be safe
                if (err.message !== 'Cloning stopped by user.') { // Assuming standard error if any
                    clonerState.logs.push(`[${new Date().toLocaleTimeString()}] Error: ${err.message}`);
                }
            });

        res.json({ success: true });
    });

    app.post('/api/cloner/stop', (req, res) => {
        if (clonerState.instance) {
            clonerState.instance.stop();
            // Logging is handled inside Cloner stop() -> log()
            res.json({ success: true, message: 'Stop signal sent.' });
        } else {
            res.json({ success: false, message: 'No active process' });
        }
    });

    app.listen(port, () => {
        console.log(`Dashboard is running on http://localhost:${port}`);
    });
};
