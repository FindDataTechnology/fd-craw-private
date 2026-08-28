// ── Vanilla JS renderer for Preferences window ──────────────────────────────

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
  t.classList.remove('active');
});
    document.querySelectorAll('.tab-panel').forEach(p => {
  p.classList.remove('active');
});
    tab.classList.add('active');
    document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
  });
});

// Load initial data
let currentSettings = {};
async function loadInitial() {
  currentSettings = await window.platform.getVisibleSettings();
  if (currentSettings.LLM_API_KEY !== undefined) {
    document.getElementById('llmApiKey').value = currentSettings.LLM_API_KEY || '';
  }
  if (currentSettings.LLM_BASE_URL !== undefined) {
    document.getElementById('llmBaseUrl').value = currentSettings.LLM_BASE_URL || '';
  }
  if (currentSettings.DEFAULT_MODEL !== undefined) {
    document.getElementById('defaultModel').value = currentSettings.DEFAULT_MODEL || '';
  }
}

loadInitial();

// General save
document.getElementById('saveGeneral').addEventListener('click', async () => {
  const statusEl = document.getElementById('generalStatus');
  const key = document.getElementById('llmApiKey').value;
  const baseUrl = document.getElementById('llmBaseUrl').value;
  const defaultModel = document.getElementById('defaultModel').value;

  if (key.trim()) {
    await window.platform.setSettingField('LLM_API_KEY', key.trim());
  }
  if (baseUrl.trim() || baseUrl === '') {
    await window.platform.setSettingField('LLM_BASE_URL', baseUrl.trim());
  }
  if (defaultModel.trim() || defaultModel === '') {
    await window.platform.setSettingField('DEFAULT_MODEL', defaultModel.trim());
  }

  const result = await window.platform.restartService('server-js');
  if (result.ok) {
    statusEl.className = 'success';
    statusEl.textContent = '✓ Saved and restarted Platform backend';
  } else {
    statusEl.className = 'error';
    statusEl.textContent = '✗ Restart failed: ' + (result.error || 'unknown error');
  }
  setTimeout(() => { statusEl.textContent = ''; }, 5000);
});

// Rotate OC tokens
document.getElementById('rotateTokens').addEventListener('click', async () => {
  if (!confirm('Really regenerate OpenConnector tokens? All existing connections will need to be reauthorized with the new tokens.')) {
    return;
  }
  const statusEl = document.getElementById('ocStatus');
  const result = await window.platform.rotateOpenConnectorTokens();
  if (!result.ok) {
    statusEl.className = 'error';
    statusEl.textContent = '✗ Failed: ' + (result.error || 'unknown error');
    return;
  }
  // Need to restart both OC and server-js (server-js has old tokens in env)
  await window.platform.restartService('openconnector');
  await window.platform.restartService('server-js');
  statusEl.className = 'success';
  statusEl.textContent = '✓ Regenerated tokens and restarted services';
  setTimeout(() => { statusEl.textContent = ''; }, 5000);
});
