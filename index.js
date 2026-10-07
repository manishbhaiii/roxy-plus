const express = require('express');
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');

const app = express();
const PORT = 3000;
const activeClients = new Map();

let connectionState = {
  phase: 'idle',
  message: 'Ready to connect your Discord accounts.'
};

function parseTokenInput(raw) {
  return [...new Set(
    String(raw || '')
      .replace(/\r/g, '')
      .split(/\n|,/)
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => token.length > 20)
  )];
}

function createClient(key, token) {
  const client = new Client({ checkUpdate: false });
  client.tokenKey = key;
  client.connectionStatus = 'connecting';
  client.userLabel = 'Connecting...';

  client.on('ready', () => {
    client.connectionStatus = 'online';
    client.userLabel = client.user ? client.user.tag : 'Ready';
    connectionState.phase = 'connected';
    connectionState.message = `${activeClients.size} account(s) online`;
    console.log(`[KAIZEN] ${key} connected as ${client.user.tag}`);
  });

  client.on('disconnect', () => {
    client.connectionStatus = 'offline';
    client.userLabel = 'Disconnected';
  });

  client.on('error', (error) => {
    client.connectionStatus = 'error';
    client.userLabel = 'Error';
    console.error(`[KAIZEN] ${key} client error:`, error.message || error);
  });

  return client;
}

async function clearClients() {
  for (const [, entry] of activeClients) {
    try {
      if (entry.client && typeof entry.client.destroy === 'function') {
        await entry.client.destroy();
      }
    } catch (error) {
      console.error('[KAIZEN] Failed to destroy client:', error.message);
    }
  }

  activeClients.clear();
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  const list = Array.from(activeClients.values()).map((entry) => ({
    key: entry.key,
    status: entry.client.connectionStatus || 'connecting',
    label: entry.client.userLabel || 'Connecting...',
    token: `${entry.token.slice(0, 8)}••••${entry.token.slice(-4)}`,
    ready: entry.client.connectionStatus === 'online'
  }));

  res.json({
    ok: true,
    phase: connectionState.phase,
    message: connectionState.message,
    total: list.length,
    ready: list.filter((item) => item.ready).length,
    accounts: list
  });
});

app.post('/api/connect', async (req, res) => {
  const tokens = parseTokenInput(req.body.tokens);

  if (!tokens.length) {
    return res.status(400).json({
      success: false,
      message: 'Please paste at least one Discord token.'
    });
  }

  try {
    await clearClients();
  } catch (error) {
    console.error('[KAIZEN] Cleanup failed:', error.message);
  }

  connectionState = {
    phase: 'connecting',
    message: `Connecting ${tokens.length} account(s)...`
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const key = `account_${index + 1}`;
    const client = createClient(key, token);

    activeClients.set(key, { key, token, client });

    client.login(token).catch((error) => {
      client.connectionStatus = 'error';
      client.userLabel = 'Login failed';
      console.error(`[KAIZEN] ${key} login failed:`, error.message || error);
      connectionState.phase = 'error';
      connectionState.message = 'One or more accounts failed to connect.';
    });
  }

  const readyCount = Array.from(activeClients.values()).filter((entry) => entry.client.connectionStatus === 'online').length;
  connectionState.phase = readyCount > 0 ? 'connected' : 'connecting';
  connectionState.message = readyCount > 0
    ? `${readyCount} account(s) online`
    : `Connecting ${tokens.length} account(s)...`;

  res.json({
    success: true,
    count: tokens.length,
    ready: readyCount,
    message: connectionState.message
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`[KAIZEN] Web dashboard running on http://localhost:${PORT}`);
  console.log(`[KAIZEN] Local access: http://${HOST}:${PORT}`);
  console.log('[KAIZEN] Open this address on the same device to connect accounts.');
});
