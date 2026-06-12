const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Change signature
content = content.replace('module.exports = (client) => {', 'module.exports = (clients) => {\n' +
`    // Middleware to set active client
    app.use((req, res, next) => {
        if (!req.url.startsWith('/css') && !req.url.startsWith('/js') && !req.url.startsWith('/img')) {
            let activeKey = req.cookies.active_client || 'TOKEN';
            req.client = clients.find(c => c.tokenKey === activeKey);
            if (!req.client && clients.length > 0) req.client = clients[0];
            res.locals.clients = clients;
            res.locals.activeClientKey = req.client ? req.client.tokenKey : null;
            res.locals.clientUser = req.client ? req.client.user : null;
        }
        next();
    });

    // API to switch client
    app.post('/api/switch_client', (req, res) => {
        const { key } = req.body;
        if (clients.find(c => c.tokenKey === key)) {
            res.cookie('active_client', key, { maxAge: 30 * 24 * 60 * 60 * 1000 });
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    });

    const MULTI_QUEST_MANAGERS = new Map();
    for (const c of clients) {
        MULTI_QUEST_MANAGERS.set(c.tokenKey, new QuestManager(c.token));
    }
`);

// 2. Remove old questManager init
content = content.replace(/const questManager = new QuestManager\([^\)]+\);\n*/, '');

// 3. Replace questManager variable accesses with dynamic one
content = content.replace(/\bquestManager\./g, 'MULTI_QUEST_MANAGERS.get(req.client.tokenKey).');
content = content.replace(/\bquestManager\b/g, 'MULTI_QUEST_MANAGERS.get(req.client.tokenKey)');

// 4. Replace `client.` with `req.client.` where it references Discord client.
// To avoid replacing things like `req.client` with `req.req.client`, only replace `\bclient\.` if it's not preceded by `req.`
content = content.replace(/(?<!req\.)\bclient\./g, 'req.client.');

// 5. Fix Data Managers calls to pass req.client
const managers = [
    'rpcManager', 'statusManager', 'aiManager', 'reactionManager',
    'mirrorManager', 'welcomerManager', 'autoMsg', 'timedMsg',
    'clipboardManager', 'qrManager', 'allowedManager'
];

managers.forEach(mgr => {
    // Methods like .saveData(, .loadData(, .addSetup(, etc.
    content = content.replace(new RegExp(`${mgr}\\.(\\w+)\\((?!req\\.client)`, 'g'), `${mgr}.$1(req.client, `);
    // Fix calls that had no arguments like .loadData(req.client, ) -> .loadData(req.client)
    content = content.replace(new RegExp(`${mgr}\\.(\\w+)\\(req\\.client, \\)`, 'g'), `${mgr}.$1(req.client)`);
});

fs.writeFileSync(filePath, content);
console.log('Dashboard backend refactored!');
