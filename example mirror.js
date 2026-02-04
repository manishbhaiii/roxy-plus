const { WebhookClient, MessageAttachment } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');

// Store active clones
let activeClones = new Map();

// Path for persistent storage
const STORAGE_PATH = path.join(__dirname, '..', 'data');
const CLONERS_FILE = path.join(STORAGE_PATH, 'active_cloners.json');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_PATH)) {
    fs.mkdirSync(STORAGE_PATH, { recursive: true });
}

// Load saved cloners
function loadSavedCloners() {
    try {
        if (fs.existsSync(CLONERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CLONERS_FILE, 'utf8'));
            return data;
        }
    } catch (error) {
        console.error('Error loading saved cloners:', error);
    }
    return {};
}

// Save current cloners
function saveCloners() {
    try {
        const dataToSave = {};
        for (const [sourceId, config] of activeClones.entries()) {
            dataToSave[sourceId] = {
                sourceChannelId: sourceId,
                cloneChannelId: config.cloneChannel.id,
                webhookId: config.webhook.id,
                webhookToken: config.webhook.token,
                startTime: config.startTime.toISOString()
            };
        }
        fs.writeFileSync(CLONERS_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (error) {
        console.error('Error saving cloners:', error);
    }
}

module.exports = {
    name: 'clone',
    description: 'Clone messages from a source channel to a destination using webhooks',
    category: 'Utility',
    async initialize(client) {
        try {
            const savedCloners = loadSavedCloners();

            for (const [sourceId, data] of Object.entries(savedCloners)) {
                try {
                    const sourceChannel = await client.channels.fetch(data.sourceChannelId);
                    const cloneChannel = await client.channels.fetch(data.cloneChannelId);

                    if (!sourceChannel || !cloneChannel) {
                        console.error(`Could not restore cloner for channel ${sourceId}: Channel not found`);
                        continue;
                    }

                    // Recreate webhook client
                    const webhook = new WebhookClient({
                        id: data.webhookId,
                        token: data.webhookToken
                    });

                    // Create message listener - FIXED VERSION
                    const messageListener = async (receivedMessage) => {
                        if (receivedMessage.channel.id !== sourceId) return;
                        // Only skip system messages and bot messages
                        if (receivedMessage.system || receivedMessage.author.bot) return;

                        // Skip if there's nothing to clone (no content, no attachments, no embeds)
                        if (!receivedMessage.content &&
                            receivedMessage.attachments.size === 0 &&
                            receivedMessage.embeds.length === 0) return;

                        try {
                            const files = [];
                            if (receivedMessage.attachments.size > 0) {
                                receivedMessage.attachments.forEach(attachment => {
                                    files.push(attachment.url);
                                });
                            }

                            const embeds = receivedMessage.embeds.length > 0 ? receivedMessage.embeds : [];

                            // Prepare webhook payload
                            const webhookPayload = {
                                username: receivedMessage.author.username,
                                avatarURL: receivedMessage.author.displayAvatarURL(),
                                files: files,
                                embeds: embeds
                            };

                            // Only add content if it exists and is not empty
                            if (receivedMessage.content && receivedMessage.content.trim()) {
                                webhookPayload.content = receivedMessage.content;
                            }

                            await webhook.send(webhookPayload);
                        } catch (error) {
                            console.error('Error cloning message:', error);
                        }
                    };

                    // Register listener
                    client.on('messageCreate', messageListener);

                    // Add to active clones
                    activeClones.set(sourceId, {
                        sourceChannel: sourceChannel,
                        cloneChannel: cloneChannel,
                        webhook: webhook,
                        listener: messageListener,
                        startTime: new Date(data.startTime)
                    });

                    console.log(`Restored cloner for channel ${sourceId}`);
                } catch (error) {
                    console.error(`Error restoring cloner for channel ${sourceId}:`, error);
                }
            }
        } catch (error) {
            console.error('Error initializing cloners:', error);
        }
    },
    async execute(message, args, commandManager) {
        // Only process for allowed users
        if (!commandManager.isAllowedUser(message.author.id)) {
            return;
        }

        // Check if at least one argument is provided
        if (args.length < 2) {
            return message.reply(`Usage:
\`!clone msg <channel_id>\` - Start cloning messages from a channel
\`!clone msg delete <channel_id>\` - Stop cloning messages and delete the clone channel
\`!clone msg list\` - List all active clones`);
        }

        const subCommand = args[1].toLowerCase();

        // Handle the 'msg' subcommand
        if (subCommand === 'msg') {
            // Check if it's a list operation
            if (args[2] && args[2].toLowerCase() === 'list') {
                return this.listClones(message, commandManager);
            }

            // Check if it's a delete operation
            if (args[2] && args[2].toLowerCase() === 'delete') {
                // Ensure a channel ID is provided
                if (!args[3]) {
                    return message.reply('Please provide a channel ID to stop cloning. Usage: `!clone msg delete <channel_id>`');
                }
                return this.stopCloning(message, args[3], commandManager);
            }

            // Otherwise, start cloning (needs a channel ID)
            if (!args[2]) {
                return message.reply('Please provide a channel ID to clone. Usage: `!clone msg <channel_id>`');
            }
            return this.startCloning(message, args[2], commandManager);
        } else {
            return message.reply(`Unknown subcommand. Available options:
\`!clone msg <channel_id>\` - Start cloning messages from a channel
\`!clone msg delete <channel_id>\` - Stop cloning messages and delete the clone channel
\`!clone msg list\` - List all active clones`);
        }
    },

    async startCloning(message, sourceChannelId, commandManager) {
        try {
            // Check if a logging server ID is configured
            if (!commandManager.config.loggingServerId) {
                // Add the logging server ID to config if not present
                commandManager.config.loggingServerId = '0'; // Default value, needs to be replaced
                commandManager.saveConfig();
                return message.reply('Please set the logging server ID in the config.json file and try again.');
            }

            // Check if the source channel is already being cloned
            if (activeClones.has(sourceChannelId)) {
                return message.reply('This channel is already being cloned. Use `!clone msg list` to see active clones.');
            }

            // Send initial processing message
            const processingMsg = await message.reply('Setting up clone channel...');

            // Get the client instance from the message
            const client = message.client;

            // Fetch the source channel
            let sourceChannel;
            try {
                sourceChannel = await client.channels.fetch(sourceChannelId);
                if (!sourceChannel) {
                    return processingMsg.edit('Could not find the source channel. Please check the channel ID.');
                }
            } catch (error) {
                console.error('Error fetching source channel:', error);
                return processingMsg.edit('Could not access the source channel. Please check the channel ID and permissions.');
            }

            // Fetch the logging server
            let loggingServer;
            try {
                loggingServer = await client.guilds.fetch(commandManager.config.loggingServerId);
                if (!loggingServer) {
                    return processingMsg.edit('Could not find the logging server. Please check the server ID in config.');
                }
            } catch (error) {
                console.error('Error fetching logging server:', error);
                return processingMsg.edit('Could not access the logging server. Please check the server ID and permissions.');
            }

            // Create a new channel in the logging server with same name
            let cloneChannel;
            try {
                // Create a sanitized channel name combining original channel name and ID for uniqueness
                let channelName = sourceChannel.name || 'clone-channel';
                // Ensure channel name is valid (no spaces, etc.)
                channelName = channelName.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30);
                channelName = `${channelName}-${sourceChannelId.substring(0, 8)}`;

                cloneChannel = await loggingServer.channels.create(channelName, {
                    type: 'GUILD_TEXT',
                    topic: `Clone of #${sourceChannel.name} (${sourceChannelId}) from ${sourceChannel.guild?.name || 'DM'}`
                });
            } catch (error) {
                console.error('Error creating clone channel:', error);
                return processingMsg.edit('Failed to create a channel in the logging server. Please check permissions.');
            }

            // Create a webhook in the clone channel
            let webhook;
            try {
                // Try creating webhook with avatar first
                try {
                    webhook = await cloneChannel.createWebhook('Message Cloner', {
                        avatar: client.user.displayAvatarURL(),
                        reason: `Message cloning for channel ${sourceChannelId}`
                    });
                } catch (avatarError) {
                    // If avatar fails, create webhook without avatar
                    console.log('Failed to create webhook with avatar, trying without...');
                    webhook = await cloneChannel.createWebhook('Message Cloner', {
                        reason: `Message cloning for channel ${sourceChannelId}`
                    });
                }
            } catch (error) {
                console.error('Error creating webhook:', error);
                await cloneChannel.delete().catch(console.error);
                return processingMsg.edit('Failed to create a webhook in the clone channel. Please check permissions.');
            }

            // Create a message listener for the source channel - FIXED VERSION
            const messageListener = async (receivedMessage) => {
                // Skip if not from the source channel we're monitoring
                if (receivedMessage.channel.id !== sourceChannelId) return;

                // Skip system messages and bot messages
                if (receivedMessage.system || receivedMessage.author.bot) return;

                // Skip if there's nothing to clone (no content, no attachments, no embeds)
                if (!receivedMessage.content &&
                    receivedMessage.attachments.size === 0 &&
                    receivedMessage.embeds.length === 0) return;

                try {
                    // Prepare attachments if any
                    const files = [];
                    if (receivedMessage.attachments.size > 0) {
                        receivedMessage.attachments.forEach(attachment => {
                            // Get the attachment URL which will work as a Discord CDN link
                            files.push(attachment.url);
                        });
                    }

                    // Handle videos and files from message content (Discord CDN links)
                    const cdnLinks = (receivedMessage.content || '').match(/https:\/\/cdn\.discordapp\.com\/[^\s]+/g) || [];
                    cdnLinks.forEach(link => {
                        if (!files.includes(link)) {
                            files.push(link);
                        }
                    });

                    // Clone embeds if any
                    const embeds = receivedMessage.embeds.length > 0 ? receivedMessage.embeds : [];

                    // Prepare webhook message payload
                    const webhookPayload = {
                        username: receivedMessage.author.username,
                        avatarURL: receivedMessage.author.displayAvatarURL(),
                        files: files,
                        embeds: embeds
                    };

                    // Only add content if it exists and is not empty
                    if (receivedMessage.content && receivedMessage.content.trim()) {
                        webhookPayload.content = receivedMessage.content;
                    }

                    // Send the message through the webhook
                    await webhook.send(webhookPayload);
                } catch (error) {
                    console.error('Error cloning message:', error);
                    // We don't want to stop the cloning process for a single failed message
                }
            };

            // Register the listener
            client.on('messageCreate', messageListener);

            // Save the clone configuration
            activeClones.set(sourceChannelId, {
                sourceChannel: sourceChannel,
                cloneChannel: cloneChannel,
                webhook: webhook,
                listener: messageListener,
                startTime: new Date()
            });

            // Save the updated cloners
            saveCloners();

            // Update the processing message
            processingMsg.edit(`Successfully set up cloning for channel <#${sourceChannelId}> to <#${cloneChannel.id}> in the logging server.`);
        } catch (error) {
            console.error('Error setting up cloning:', error);
            message.reply('There was an error setting up the cloning process.');
        }
    },

    async stopCloning(message, sourceChannelId, commandManager) {
        try {
            // Check if the channel is being cloned
            if (!activeClones.has(sourceChannelId)) {
                return message.reply('This channel is not being cloned. Use `!clone msg list` to see active clones.');
            }

            // Get the clone configuration
            const cloneConfig = activeClones.get(sourceChannelId);

            // Remove the message listener
            message.client.removeListener('messageCreate', cloneConfig.listener);

            // Delete the webhook but keep the channel
            try {
                await cloneConfig.webhook.delete('Clone stopped');
            } catch (error) {
                console.error('Error deleting webhook:', error);
            }

            // Remove from active clones
            activeClones.delete(sourceChannelId);

            // Save the updated state
            saveCloners();

            message.reply(`Successfully stopped cloning channel <#${sourceChannelId}>. The backup channel has been preserved.`);
        } catch (error) {
            console.error('Error stopping cloning:', error);
            message.reply('There was an error stopping the cloning process.');
        }
    },

    async listClones(message, commandManager) {
        try {
            if (activeClones.size === 0) {
                return message.reply('No active clones found. Use `!clone msg <channel_id>` to start cloning a channel.');
            }

            let responseText = '**📋 Active Clones:**\n\n';

            for (const [sourceId, config] of activeClones.entries()) {
                const sourceName = config.sourceChannel.name || 'Unknown Channel';
                const cloneName = config.cloneChannel.name || 'Unknown Channel';
                const startTime = config.startTime.toLocaleString();

                responseText += `**Source:** <#${sourceId}> (${sourceName})\n`;
                responseText += `**Clone:** <#${config.cloneChannel.id}> (${cloneName})\n`;
                responseText += `**Started:** ${startTime}\n\n`;
            }

            message.reply(responseText);
        } catch (error) {
            console.error('Error listing clones:', error);
            message.reply('There was an error listing active clones.');
        }
    }
};