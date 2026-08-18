const baseUrlEl = document.getElementById('baseUrl');
const inviteEl = document.getElementById('invite');
const activateBtn = document.getElementById('activate');
const statusEl = document.getElementById('status');

const setStatus = (text) => { statusEl.textContent = text; };

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('Enter your DevSpace base URL.');
  const parsed = new URL(raw);
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) throw new Error('Use HTTPS, or HTTP only for localhost.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Base URL cannot contain credentials, query parameters, or a fragment.');
  return raw;
}

async function getSavedConfig() {
  const { lastInviteCode, devspaceBaseUrl } = await chrome.storage.local.get(['lastInviteCode', 'devspaceBaseUrl']);
  if (lastInviteCode) inviteEl.value = lastInviteCode;
  if (devspaceBaseUrl) baseUrlEl.value = devspaceBaseUrl;
}

activateBtn.addEventListener('click', async () => {
  let baseUrl;
  try { baseUrl = normalizeBaseUrl(baseUrlEl.value); }
  catch (error) {
    setStatus(error.message);
    return;
  }
  const inviteCode = inviteEl.value.trim().toUpperCase();
  if (!/^[A-F0-9]{12,64}$/.test(inviteCode)) {
    setStatus('Invalid invite code.');
    return;
  }
  activateBtn.disabled = true;
  setStatus('Activating…');
  try {
    await chrome.storage.local.set({ lastInviteCode: inviteCode, devspaceBaseUrl: baseUrl });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'chat-swarm-activate', inviteCode, baseUrl });
    if (!result?.ok) throw new Error(result?.error || 'Activation failed.');
    setStatus(`PASS: ${result.workerId} parked`);
  } catch (error) {
    setStatus(`FAIL: ${error?.message || error}`);
  } finally {
    activateBtn.disabled = false;
  }
});

void getSavedConfig();
