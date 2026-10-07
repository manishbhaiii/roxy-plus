const readyCountEl = document.getElementById('readyCount');
const totalCountEl = document.getElementById('totalCount');
const statusBadgeEl = document.getElementById('statusBadge');
const connectBtn = document.getElementById('connectBtn');
const clearBtn = document.getElementById('clearBtn');
const tokenInput = document.getElementById('tokenInput');
const statusMessage = document.getElementById('statusMessage');
const accountsGrid = document.getElementById('accountsGrid');

function setStatus(message) {
  statusMessage.textContent = message;
}

function renderAccounts(accounts) {
  if (!accounts || accounts.length === 0) {
    accountsGrid.innerHTML = `
      <div class="empty-state">
        No accounts connected yet.<br />
        Paste tokens and click Connect to begin.
      </div>
    `;
    return;
  }

  accountsGrid.innerHTML = accounts.map((account) => `
    <article class="account-card">
      <div class="account-meta">
        <h4>${account.label}</h4>
        <span class="badge ${account.status}">${account.status}</span>
      </div>
      <div class="account-token">${account.token}</div>
      <div class="account-token">Key: ${account.key}</div>
    </article>
  `).join('');
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status');
    const payload = await response.json();

    readyCountEl.textContent = payload.ready || 0;
    totalCountEl.textContent = payload.total || 0;
    statusBadgeEl.textContent = (payload.phase || 'idle').toUpperCase();
    setStatus(payload.message || 'Ready to connect your accounts.');
    renderAccounts(payload.accounts || []);
  } catch (error) {
    setStatus('Unable to reach the Kaizen server.');
  }
}

connectBtn.addEventListener('click', async () => {
  const tokens = tokenInput.value;

  if (!tokens.trim()) {
    setStatus('Paste at least one Discord token before connecting.');
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';
  setStatus('Connecting accounts...');

  try {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || 'Connection failed.');
    }

    setStatus(payload.message || 'Connection request started.');
  } catch (error) {
    setStatus(error.message || 'Connection failed.');
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});

clearBtn.addEventListener('click', () => {
  tokenInput.value = '';
  setStatus('Input cleared. Paste your Discord tokens to continue.');
});

setInterval(refreshStatus, 2000);
refreshStatus();
