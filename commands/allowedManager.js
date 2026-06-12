const fs = require('fs');
const path = require('path');

function getFile(client) {
    const folder = client && client.dataFolder ? client.dataFolder : 'data';
    return path.join(__dirname, '..', folder, 'allowed.json');
}

function loadData(client) {
    try {
        const file = getFile(client);
        if (!fs.existsSync(file)) {
            const folder = client && client.dataFolder ? client.dataFolder : 'data';
            const dataDir = path.join(__dirname, '..', folder);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            const defaultData = { allowedUsers: [] };
            fs.writeFileSync(file, JSON.stringify(defaultData, null, 4));
            return defaultData;
        }
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Ensure structure
        if (!data.allowedUsers) data.allowedUsers = [];
        return data;
    } catch (e) {
        console.error('[Allowed Manager] Error loading data:', e);
        return { allowedUsers: [] };
    }
}

function saveData(client, data) {
    try {
        const folder = client && client.dataFolder ? client.dataFolder : 'data';
        const dataDir = path.join(__dirname, '..', folder);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(getFile(client), JSON.stringify(data, null, 4));
    } catch (e) {
        console.error('[Allowed Manager] Error saving data:', e);
    }
}

function addAllowedUser(client, userId) {
    const data = loadData(client);
    if (!data.allowedUsers.includes(userId)) {
        data.allowedUsers.push(userId);
        saveData(client, data);
        return true;
    }
    return false;
}

function removeAllowedUser(client, userId) {
    const data = loadData(client);
    if (data.allowedUsers.includes(userId)) {
        data.allowedUsers = data.allowedUsers.filter(id => id !== userId);
        saveData(client, data);
        return true;
    }
    return false;
}

function isAllowed(client, userId) {
    const data = loadData(client);
    return data.allowedUsers.includes(userId);
}

module.exports = {
    loadData,
    saveData,
    addAllowedUser,
    removeAllowedUser,
    isAllowed
};
