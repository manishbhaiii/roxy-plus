const fs = require('fs');
const path = require('path');

function getFile(client) {
    const folder = client && client.dataFolder ? client.dataFolder : 'data';
    return path.join(__dirname, '..', folder, 'welcomer.json');
}

function loadData(client) {
    const file = getFile(client);
    if (!fs.existsSync(file)) {
        const folder = client && client.dataFolder ? client.dataFolder : 'data';
        const dataDir = path.join(__dirname, '..', folder);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ welcomeSetups: {} }));
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.welcomeSetups) {
        data.welcomeSetups = {};
        saveData(client, data);
    }
    return data;
}

function saveData(client, data) {
    fs.writeFileSync(getFile(client), JSON.stringify(data, null, 2));
}

function addSetup(client, guildId, channelId, template, background, textcolor, welcomeType = 'card', textMessage, cardMessage) {
    const data = loadData(client);
    data.welcomeSetups[guildId] = { channelId, template, background, textcolor, welcomeType, textMessage, cardMessage };
    saveData(client, data);
}

function removeSetup(client, guildId) {
    const data = loadData(client);
    if (data.welcomeSetups[guildId]) {
        delete data.welcomeSetups[guildId];
        saveData(client, data);
    }
}

function getSetup(client, guildId) {
    const data = loadData(client);
    return data.welcomeSetups[guildId];
}

module.exports = { loadData, saveData, addSetup, removeSetup, getSetup };
