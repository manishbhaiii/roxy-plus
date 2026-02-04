const { WebhookClient } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../data/mirror_config.json');

let activeMirrors = new Map();

function loadData() {
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 4));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveData() {
    const data = {};
    for (const [sourceId, config] of activeMirrors.entries()) {
        data[sourceId] = {
            sourceId: config.sourceId,
            targetId: config.targetId,
            mode: config.mode,
            webhook: config.webhook,
            startTime: config.startTime
        };
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 4));
}

async function initialize(client) {
    console.log("[Mirror System] Initializing...");
    const saved = loadData();

    for (const [sourceId, config] of Object.entries(saved)) {
        try {
            await startMirror(client, config.sourceId, config.targetId, config.mode, config.webhook, true);
        } catch (e) {
            console.error(`[Mirror] Failed to restore mirror for ${sourceId}:`, e.message);
        }
    }

    client.on('messageCreate', async (message) => {
        if (!activeMirrors.has(message.channel.id)) return;
        const config = activeMirrors.get(message.channel.id);

        if (message.author.id === client.user.id) return;
        if (message.author.bot) return;
        if (message.system) return;

        try {
            await processMirror(client, message, config);
        } catch (e) {
            console.error(`[Mirror] Error processing message from ${message.channel.id}:`, e.message);
        }
    });

    console.log(`[Mirror System] Restored ${activeMirrors.size} mirrors.`);
}

async function startMirror(client, sourceId, targetId, mode, webhookData = null, isRestoring = false) {
    if (activeMirrors.has(sourceId)) {
        throw new Error("Mirror already active for this source channel.");
    }

    const sourceChannel = await client.channels.fetch(sourceId).catch(() => null);
    const targetChannel = await client.channels.fetch(targetId).catch(() => null);

    if (!sourceChannel) throw new Error("Invalid Source Channel.");
    if (!targetChannel) throw new Error("Invalid Target Channel.");

    let webhookInfo = webhookData;
    let webhookClient = null;

    if (mode === 'webhook') {
        if (!webhookInfo) {
            const hooks = await targetChannel.fetchWebhooks().catch(() => null);
            let hook = hooks ? hooks.find(h => h.token) : null;

            if (!hook) {
                try {
                    hook = await targetChannel.createWebhook('Mirror Bot', {
                        avatar: client.user.displayAvatarURL(),
                        reason: 'Mirror System'
                    });
                } catch (e) {
                    throw new Error("Failed to create Webhook. Check Permissions in Target Channel.");
                }
            }
            webhookInfo = { id: hook.id, token: hook.token };
        }

        webhookClient = new WebhookClient({ id: webhookInfo.id, token: webhookInfo.token });
    }

    const config = {
        sourceId,
        targetId,
        mode,
        webhook: webhookInfo,
        webhookClient,
        startTime: new Date().toISOString()
    };

    activeMirrors.set(sourceId, config);

    if (!isRestoring) {
        saveData();
    }
}

async function stopMirror(sourceId) {
    if (!activeMirrors.has(sourceId)) return false;
    activeMirrors.delete(sourceId);
    saveData();
    return true;
}

// WORKAROUND: Send attachment URLs as text content so they embed
async function processMirror(client, message, config) {
    const { mode, targetId, webhookClient } = config;

    if (!message.content && message.attachments.size === 0 && message.embeds.length === 0) return;

    // Collect attachment URLs
    const attachmentUrls = [];
    if (message.attachments.size > 0) {
        message.attachments.forEach(attachment => {
            attachmentUrls.push(attachment.url);
        });
    }

    // Extract CDN links from content
    const cdnLinks = (message.content || '').match(/https:\/\/cdn\.discordapp\.com\/[^\s]+/g) || [];
    cdnLinks.forEach(link => {
        if (!attachmentUrls.includes(link)) {
            attachmentUrls.push(link);
        }
    });

    const embeds = message.embeds.length > 0 ? message.embeds : [];

    // Build content: original message + attachment URLs (so they auto-embed)
    let finalContent = message.content || '';
    if (attachmentUrls.length > 0) {
        // Add URLs to content separated by newlines
        const urlText = attachmentUrls.join('\n');
        finalContent = finalContent ? `${finalContent}\n${urlText}` : urlText;
    }

    const webhookPayload = {
        username: message.author.username,
        avatarURL: message.author.displayAvatarURL(),
        embeds: embeds
    };

    if (finalContent.trim()) {
        webhookPayload.content = finalContent;
    }

    if (mode === 'webhook' && webhookClient) {
        try {
            await webhookClient.send(webhookPayload);
        } catch (e) {
            console.error(`[Mirror] Webhook Error:`, e.message);
        }
    } else {
        const targetChannel = await client.channels.fetch(targetId).catch(() => null);
        if (targetChannel) {
            try {
                await targetChannel.send(webhookPayload);
            } catch (e) {
                console.error(`[Mirror] Send Error:`, e.message);
            }
        }
    }
}

function getActiveMirrors() {
    const list = [];
    for (const [sourceId, config] of activeMirrors.entries()) {
        list.push({
            sourceId,
            targetId: config.targetId,
            mode: config.mode,
            startTime: config.startTime
        });
    }
    return list;
}

module.exports = { initialize, startMirror, stopMirror, getActiveMirrors, loadData };
