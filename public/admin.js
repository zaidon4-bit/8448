'use strict';
const $ = id => document.getElementById(id);
let users = [];
let selectedId = null;
let defaultSystemPrompt = '';
let globalSettingsLoaded = false;
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to complete the request.');
  return data;
}
function notice(message, isError = false) {
  const el = $('adminNotice'); el.textContent = message;
  el.className = `notice ${isError ? 'notice-error' : 'notice-success'}`;
}
function pill(text, className = '') {
  const node = document.createElement('span'); node.className = `pill ${className}`; node.textContent = text; return node;
}
function showAccessDenied(message) {
  $('accessDenied').classList.remove('hidden'); $('adminContent').classList.add('hidden');
  if (message) notice(message, true);
}
function subscriptionLabel(user) {
  if (user.subscriptionRequestedAt) return 'Approval pending';
  if (user.subscriptionActive) return 'Active';
  if (user.subscriptionStatus === 'active') return 'Expired';
  return 'Inactive';
}
function renderUsers() {
  const list = $('usersList'); list.replaceChildren();
  const q = $('userSearch').value.trim().toLowerCase();
  const shown = users.filter(user => user.email.toLowerCase().includes(q));
  if (!shown.length) { const empty = document.createElement('div'); empty.className = 'admin-empty'; empty.textContent = 'No matching users.'; list.append(empty); return; }
  for (const user of shown) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `user-row${user.id === selectedId ? ' active' : ''}`;
    const info = document.createElement('div'); info.style.minWidth = '0';
    const email = document.createElement('div'); email.className = 'user-email'; email.textContent = user.email;
    const meta = document.createElement('div'); meta.className = 'user-meta';
    const apiLabel = user.apiConfigured ? 'Custom API' : (user.assistantConfigured ? 'Default API' : 'API not configured');
    meta.append(pill(`#${user.id}`), pill(apiLabel, user.assistantConfigured ? 'good' : ''));
    meta.append(pill(subscriptionLabel(user), user.subscriptionActive ? 'good' : (user.subscriptionRequestedAt ? 'pending' : '')));
    if (user.isDisabled) meta.append(pill('Disabled', 'bad'));
    info.append(email, meta); button.append(info); button.addEventListener('click', () => selectUser(user.id)); list.append(button);
  }
}
function selectUser(id) {
  const user = users.find(item => item.id === Number(id)); if (!user) return;
  selectedId = user.id;
  $('selectedUserId').value = String(user.id);
  $('editorTitle').textContent = `User #${user.id}`;
  $('editorSubtitle').textContent = user.email;
  $('apiBaseUrl').value = user.apiBaseUrl || '';
  $('modelId').value = user.modelId || '';
  $('apiKey').value = '';
  $('apiKey').placeholder = user.apiConfigured ? 'Saved key; enter a new key to replace it' : 'Enter this user’s API key';
  $('isDisabled').checked = user.isDisabled;
  $('subscriptionStatusPill').textContent = subscriptionLabel(user);
  $('subscriptionStatusPill').className = `pill ${user.subscriptionActive ? 'good' : (user.subscriptionRequestedAt ? 'pending' : '')}`;
  $('subscriptionRequestInfo').textContent = user.subscriptionRequestedAt ? `Activation request received: ${user.subscriptionRequestedAt}` : 'No pending activation request.';
  $('subscriptionEndInfo').textContent = user.subscriptionCurrentPeriodEnd ? `Membership expires: ${new Date(user.subscriptionCurrentPeriodEnd * 1000).toLocaleString('en-US')}` : 'No membership expiry is currently set.';
  $('subscriptionDays').value = '30';
  $('activateSubscription').textContent = `Verify payment and activate for ${$('subscriptionDays').value} days`;
  $('apiStatus').textContent = user.apiConfigured ? 'Custom API saved' : (user.assistantConfigured ? 'Using server default API' : 'AI connection missing');
  $('apiStatus').style.color = user.assistantConfigured ? '#a7efd4' : '#ffabb4';
  renderUsers();
}
async function loadGlobalSettings() {
  const data = await api('/api/admin/settings');
  $('systemPrompt').value = data.systemPrompt || '';
  defaultSystemPrompt = data.defaultSystemPrompt || data.systemPrompt || '';
  $('reasoningLevel').value = ['low', 'medium', 'high'].includes(data.reasoningLevel) ? data.reasoningLevel : 'low';
  globalSettingsLoaded = true;
}
$('globalSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!globalSettingsLoaded) return notice('Global settings have not loaded yet. Refresh the page and try again.', true);
  const button = $('saveGlobalSettings');
  button.disabled = true;
  try {
    const data = await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ systemPrompt: $('systemPrompt').value, reasoningLevel: $('reasoningLevel').value })
    });
    notice(data.promptUpdated ? 'Assistant settings saved. Active workers were restarted to load the new System Prompt.' : 'Assistant settings saved.');
    await loadGlobalSettings();
  } catch (err) { notice(err.message, true); }
  finally { button.disabled = false; }
});
$('restoreDefaultPrompt').addEventListener('click', () => {
  if (!defaultSystemPrompt) return notice('Default System Prompt has not loaded yet.', true);
  if (window.confirm('Replace the editor contents with the built-in default prompt? Click Save assistant settings to apply it.')) $('systemPrompt').value = defaultSystemPrompt;
});

async function loadUsers(keepNotice = false) {
  $('refreshUsers').disabled = true;
  try {
    const data = await api('/api/admin/users'); users = data.users || [];
    await loadGlobalSettings();
    $('accessDenied').classList.add('hidden'); $('adminContent').classList.remove('hidden');
    renderUsers();
    if (selectedId && users.some(user => user.id === selectedId)) selectUser(selectedId);
    else if (users.length) selectUser(users[0].id);
    if (!keepNotice) $('adminNotice').classList.add('hidden');
  } catch (err) {
    if (/sign in/i.test(err.message)) showAccessDenied('Sign in with the administrator account, then reopen this page.');
    else if (/restricted to administrators/i.test(err.message)) showAccessDenied(err.message);
    else notice(err.message, true);
  } finally { $('refreshUsers').disabled = false; }
}
$('refreshUsers').addEventListener('click', () => loadUsers());
$('userSearch').addEventListener('input', renderUsers);
$('userConfigForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedId) return notice('Select a user first.', true);
  const button = $('saveUser'); button.disabled = true;
  const payload = { baseUrl: $('apiBaseUrl').value.trim(), modelId: $('modelId').value.trim(), isDisabled: $('isDisabled').checked };
  if ($('apiKey').value.trim()) payload.apiKey = $('apiKey').value.trim();
  try {
    await api(`/api/admin/users/${selectedId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    $('apiKey').value = '';
    notice('User settings saved. The stored API key is never shown again.');
    await loadUsers(true);
  } catch (err) { notice(err.message, true); }
  finally { button.disabled = false; }
});
$('subscriptionDays').addEventListener('input', () => {
  $('activateSubscription').textContent = `Verify payment and activate for ${$('subscriptionDays').value || '…'} days`;
});
async function updateSubscription(action) {
  if (!selectedId) return notice('Select a user first.', true);
  const days = Number($('subscriptionDays').value || 30);
  if (action === 'activate' && (!Number.isInteger(days) || days < 1 || days > 3650)) return notice('Membership duration must be between 1 and 3650 days.', true);
  const user = users.find(item => item.id === selectedId);
  const prompt = action === 'activate'
    ? `Have you verified payment and do you want to activate ${user ? user.email : 'this user'} for ${days} days?`
    : `Deactivate membership for ${user ? user.email : 'this user'} immediately?`;
  if (!window.confirm(prompt)) return;
  const button = action === 'activate' ? $('activateSubscription') : $('deactivateSubscription');
  button.disabled = true;
  try {
    await api(`/api/admin/users/${selectedId}/subscription`, {
      method: 'POST', body: JSON.stringify(action === 'activate' ? { action, days } : { action })
    });
    notice(action === 'activate' ? `Membership manually activated for ${days} days.` : 'Membership deactivated.');
    await loadUsers(true);
  } catch (err) { notice(err.message, true); }
  finally { button.disabled = false; }
}
$('activateSubscription').addEventListener('click', () => updateSubscription('activate'));
$('deactivateSubscription').addEventListener('click', () => updateSubscription('deactivate'));
$('clearApi').addEventListener('click', async () => {
  if (!selectedId) return notice('Select a user first.', true);
  if (!window.confirm('Clear this user’s custom API connection? A server-wide default, if configured, will remain available.')) return;
  const button = $('clearApi'); button.disabled = true;
  try {
    await api(`/api/admin/users/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ clearApiConfig: true, isDisabled: $('isDisabled').checked }) });
    $('apiKey').value = ''; notice('Custom API connection cleared.'); await loadUsers(true);
  } catch (err) { notice(err.message, true); }
  finally { button.disabled = false; }
});
loadUsers();
