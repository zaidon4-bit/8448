'use strict';

const $ = id => document.getElementById(id);
let authMode = 'register';
let currentUser = null;
let config = { productName: 'CodeCraft Studio', subscriptionPriceLabel: 'Manual activation after administrator review', assistantConfigured: false, paymentsConfigured: false, manualApprovalEnabled: true };
let busy = false;

$('year').textContent = new Date().getFullYear();

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) }
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : { error: await response.text() };
  if (!response.ok) throw new Error(payload.error || 'Unable to complete the request. Please try again.');
  return payload;
}
function showNotice(target, message, type = 'error') {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  el.className = `notice notice-${type}`;
  el.textContent = message;
}
function hide(el) { el.classList.add('hidden'); }
function show(el) { el.classList.remove('hidden'); }
function showGlobal(message, error = false) {
  const el = $('globalNotice');
  el.textContent = message;
  el.style.borderColor = error ? '#a6425369' : '#4ebf9a55';
  el.style.color = error ? '#ffabb4' : '#a8ecd2';
  show(el);
  window.setTimeout(() => hide(el), 7000);
}
function scrollChatToBottom() {
  const box = $('chatMessages');
  box.scrollTop = box.scrollHeight;
}
function removeEmptyState() { const empty = $('emptyState'); if (empty) empty.remove(); }
function addInlineText(parent, text) {
  const regex = /`([^`]+)`/g;
  let cursor = 0, match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const code = document.createElement('code');
    code.textContent = match[1];
    parent.append(code);
    cursor = regex.lastIndex;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}
function renderMarkdownSafe(container, text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) codeLines.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.append(code); container.append(pre); continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const h = document.createElement(`h${heading[1].length + 1}`);
      addInlineText(h, heading[2]); container.append(h); i++; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = document.createElement('ul');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement('li');
        addInlineText(li, lines[i].replace(/^\s*[-*]\s+/, ''));
        ul.append(li); i++;
      }
      container.append(ul); continue;
    }
    const p = document.createElement('p');
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) paragraph.push(lines[i++]);
    addInlineText(p, paragraph.join('\n')); container.append(p);
  }
}
function formatElapsed(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  return `${Math.floor(value / 1000)} s ${String(value % 1000).padStart(3, '0')} ms`;
}
function addMessage(role, content, metadata = null) {
  removeEmptyState();
  const wrap = document.createElement('article');
  wrap.className = `message ${role}${metadata && metadata.isError ? ' message-error' : ''}`;
  const head = document.createElement('div'); head.className = 'message-head';
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? 'Y' : '✦';
  const label = document.createElement('span'); label.textContent = role === 'user' ? 'You' : 'CodeCraft';
  head.append(avatar, label);
  const body = document.createElement('div'); body.className = 'message-body';
  renderMarkdownSafe(body, content);
  wrap.append(head, body);
  if (role === 'assistant' && metadata && typeof metadata === 'object') {
    const metrics = document.createElement('div'); metrics.className = 'message-metrics';
    const durationMs = Number(metadata.durationMs);
    const time = document.createElement('span');
    time.textContent = `Response time: ${Number.isFinite(durationMs) ? formatElapsed(durationMs) : 'unavailable'}`;
    metrics.append(time);
    const usage = metadata.tokenUsage;
    const tokens = document.createElement('span');
    if (usage && usage.total !== null && usage.total !== undefined && Number.isFinite(Number(usage.total))) {
      const details = [];
      if (usage.input !== null && usage.input !== undefined) details.push(`${Number(usage.input).toLocaleString('en-US')} input`);
      if (usage.output !== null && usage.output !== undefined) details.push(`${Number(usage.output).toLocaleString('en-US')} output`);
      tokens.textContent = `Tokens used: ${Number(usage.total).toLocaleString('en-US')} total${details.length ? ` · ${details.join(' · ')}` : ''}`;
    } else {
      tokens.textContent = 'Token usage: unavailable (provider did not report usage)';
    }
    metrics.append(tokens);
    wrap.append(metrics);
  }
  $('chatMessages').append(wrap); scrollChatToBottom();
}
function startThinkingIndicator() {
  const row = document.createElement('div');
  row.className = 'thinking-row';
  row.setAttribute('role', 'status');
  row.setAttribute('aria-live', 'polite');
  const animation = document.createElement('iframe');
  animation.src = '/yellow-cube-v3.html?compact=1';
  animation.title = 'Thinking animation';
  animation.setAttribute('aria-hidden', 'true');
  animation.tabIndex = -1;
  const status = document.createElement('span'); status.className = 'thinking-label'; status.textContent = 'Thinking';
  const timer = document.createElement('span'); timer.className = 'thinking-timer'; timer.textContent = '0 s 000 ms';
  row.append(animation, status, timer);
  $('chatMessages').append(row);
  const started = performance.now();
  const tick = () => { timer.textContent = formatElapsed(performance.now() - started); };
  tick();
  const interval = window.setInterval(tick, 25);
  scrollChatToBottom();
  return {
    row,
    stop: () => { window.clearInterval(interval); tick(); row.remove(); return Math.round(performance.now() - started); }
  };
}

function addToolActivity(tools) {
  const names = [...new Set((Array.isArray(tools) ? tools : []).filter(name => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name)))];
  if (!names.length) return;
  const row = document.createElement('div'); row.className = 'tool-activity';
  const icon = document.createElement('span'); icon.className = 'tool-activity-dot'; icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.textContent = `Tools used: ${names.join(' · ')}`;
  row.append(icon, label); $('chatMessages').append(row); scrollChatToBottom();
}
function setView(view) {
  $('hero').classList.toggle('hidden', view !== 'landing');
  $('authSection').classList.toggle('hidden', view !== 'auth');
  $('membershipSection').classList.toggle('hidden', view !== 'membership');
  $('workspaceSection').classList.toggle('hidden', view !== 'workspace');
  $('topLogin').classList.toggle('hidden', view !== 'landing' && view !== 'auth' || !!currentUser);
  $('topLogout').classList.toggle('hidden', !currentUser);
  if (view === 'workspace') document.body.classList.add('in-workspace'); else document.body.classList.remove('in-workspace');
}
function renderUser() {
  $('topLogout').classList.toggle('hidden', !currentUser);
  $('topLogin').classList.toggle('hidden', !!currentUser);
  $('topAdmin').classList.toggle('hidden', !(currentUser && currentUser.isAdmin));
  if (!currentUser) { setView('landing'); return; }
  $('userEmail').textContent = currentUser.email;
  $('avatar').textContent = (currentUser.email[0] || 'U').toUpperCase();
  if (currentUser.subscriptionActive) {
    $('subscriptionBadge').textContent = 'Active membership';
    setView('workspace');
    loadHistory();
  } else {
    $('priceDisplay').textContent = config.subscriptionPriceLabel || 'Manual activation after administrator review';
    const requested = !!currentUser.subscriptionRequestedAt;
    const requestButton = $('requestActivationButton');
    if (requestButton) {
      requestButton.disabled = requested;
      requestButton.innerHTML = requested ? 'Review request sent ✓' : 'Request activation review <span>←</span>';
    }
    const statusText = $('membershipStatusText');
    if (statusText) statusText.textContent = requested
      ? 'Your request is under review. An administrator will activate membership after verification.'
      : 'After completing payment through the agreed method, request a review. An administrator will activate membership manually.';
    setView('membership');
  }
}
async function loadHistory() {
  const box = $('chatMessages');
  box.innerHTML = '<div id="emptyState" class="empty-state"><div class="empty-orbit"><span>⌘</span></div><h3>Your workspace is ready</h3><p>Enter a coding task or upload project files to work on in your private workspace.</p></div>';
  try {
    const data = await request('/api/chat/history');
    if (data.messages && data.messages.length) {
      box.innerHTML = '';
      for (const m of data.messages) addMessage(m.role, m.content, m.metadata);
    }
  } catch (err) {
    if (!/subscription|sign in/.test(err.message)) showGlobal(err.message, true);
  }
}
function setAuthMode(mode) {
  authMode = mode;
  $('authTitle').textContent = mode === 'register' ? 'Create your account' : 'Welcome back';
  $('registerTab').classList.toggle('active', mode === 'register');
  $('loginTab').classList.toggle('active', mode === 'login');
  $('authSubmit').innerHTML = mode === 'register' ? 'Create account <span>←</span>' : 'Sign in <span>→</span>';
  $('authForm').querySelector('[name="password"]').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  $('authForm').querySelector('[name="password"]').setAttribute('minlength', mode === 'register' ? '10' : '1');
  $('authHint').textContent = mode === 'register' ? 'Use a strong password you do not use on other websites.' : 'Enter the credentials for your existing account.';
  hide($('authError'));
}
async function loadInitial() {
  try { config = await request('/api/config'); } catch {}
  $('priceDisplay').textContent = config.subscriptionPriceLabel || 'Manual activation after administrator review';
  try {
    const data = await request('/api/me');
    currentUser = data.user;
    renderUser();
  } catch { currentUser = null; renderUser(); }
}
async function refreshMembership(retry = false) {
  const button = $('refreshMembership');
  if (button) { button.disabled = true; button.textContent = 'Checking…'; }
  try {
    const tries = retry ? 4 : 1;
    for (let i = 0; i < tries; i++) {
      const data = await request('/api/me');
      currentUser = data.user;
      if (currentUser && currentUser.subscriptionActive) { renderUser(); showGlobal('Membership activated successfully.'); return; }
      if (i < tries - 1) await new Promise(resolve => setTimeout(resolve, 1600));
    }
    renderUser();
    const note = $('billingNote');
    showNotice(note, currentUser && currentUser.subscriptionRequestedAt ? 'Your activation request is still under administrator review. Refresh the status later.' : 'Membership is not active yet. Request a review after completing payment.', 'error');
  } catch (err) { showGlobal(err.message, true); }
  finally { if (button) { button.disabled = false; button.textContent = 'Refresh membership status'; } }
}

$('heroStart').addEventListener('click', () => { setView(currentUser ? (currentUser.subscriptionActive ? 'workspace' : 'membership') : 'auth'); if (!currentUser) setAuthMode('register'); });
$('topLogin').addEventListener('click', () => { setView('auth'); setAuthMode('login'); });
$('registerTab').addEventListener('click', () => setAuthMode('register'));
$('loginTab').addEventListener('click', () => setAuthMode('login'));
$('authForm').addEventListener('submit', async event => {
  event.preventDefault(); hide($('authError'));
  const button = $('authSubmit'); button.disabled = true; button.textContent = 'Checking…';
  const form = new FormData(event.currentTarget);
  try {
    const data = await request(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    currentUser = data.user; event.currentTarget.reset(); renderUser(); showGlobal(authMode === 'register' ? 'Account created.' : 'Signed in successfully.');
  } catch (err) { showNotice('authError', err.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = authMode === 'register' ? 'Create account <span>←</span>' : 'Sign in <span>→</span>'; }
});
$('topLogout').addEventListener('click', async () => {
  try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  currentUser = null; renderUser(); showGlobal('Signed out.');
});
$('requestActivationButton').addEventListener('click', async () => {
  const button = $('requestActivationButton'); button.disabled = true;
  try {
    const data = await request('/api/billing/request-activation', { method: 'POST', body: '{}' });
    const refreshed = await request('/api/me'); currentUser = refreshed.user; renderUser();
    showNotice($('billingNote'), data.message || 'Activation review request submitted.', 'success');
  } catch (err) {
    showNotice($('billingNote'), err.message, 'error');
    button.disabled = false;
  }
});
$('refreshMembership').addEventListener('click', () => refreshMembership(false));
$('newChatButton').addEventListener('click', async () => {
  try { await request('/api/chat/new', { method: 'POST', body: '{}' }); $('chatMessages').innerHTML = '<div id="emptyState" class="empty-state"><div class="empty-orbit"><span>⌘</span></div><h3>New chat</h3><p>Describe the task you want implemented.</p></div>'; }
  catch (err) { showGlobal(err.message, true); }
});
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => { $('chatInput').value = button.textContent.trim(); $('chatInput').focus(); }));
function resizeComposer() {
  const input = $('chatInput');
  if (!input) return;
  input.style.height = 'auto';
  const maxHeight = window.matchMedia('(max-width: 740px)').matches ? 160 : 180;
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
}
$('chatInput').addEventListener('input', resizeComposer);
$('chatInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('chatForm').requestSubmit(); }
});
$('chatForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const text = $('chatInput').value.trim();
  if (!text) return;
  busy = true; $('chatInput').disabled = true; $('sendButton').disabled = true; hide($('chatError'));
  addMessage('user', text); $('chatInput').value = ''; resizeComposer();
  const thinking = startThinkingIndicator();
  try {
    const data = await request('/api/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
    const clientDurationMs = thinking.stop();
    const metadata = {
      durationMs: Number.isFinite(Number(data.durationMs)) ? Number(data.durationMs) : clientDurationMs,
      tokenUsage: data.tokenUsage || null
    };
    addMessage('assistant', data.answer, metadata);
    addToolActivity(data.toolsUsed);
  } catch (err) {
    const durationMs = thinking.stop();
    hide($('chatError'));
    const detail = String(err && err.message || 'The task could not be completed. Please try again.');
    addMessage('assistant', detail, { durationMs, tokenUsage: null, isError: true });
  } finally {
    $('chatInput').disabled = false; $('sendButton').disabled = false; resizeComposer(); $('chatInput').focus(); busy = false;
  }
});

loadInitial();

$('uploadFiles').addEventListener('click', () => $('projectFiles').click());
$('projectFiles').addEventListener('change', async event => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  if (files.length > 30) { showNotice('chatError', 'Select 30 files or fewer per upload.', 'error'); event.target.value = ''; return; }
  const form = new FormData();
  const paths = [];
  for (const file of files) {
    paths.push(file.webkitRelativePath || file.name);
    form.append('files', file, file.name);
  }
  form.append('paths', JSON.stringify(paths));
  const button = $('uploadFiles'); button.disabled = true; button.textContent = 'Uploading files…';
  try {
    const data = await request('/api/workspace/upload', { method: 'POST', body: form });
    showGlobal(data.message || 'Files uploaded to your workspace.');
    if (data.skipped) showGlobal(`Skipped ${data.skipped} sensitive or disallowed file(s).`, true);
  } catch (err) { showNotice('chatError', err.message, 'error'); }
  finally { button.disabled = false; button.textContent = '＋ Attach files'; event.target.value = ''; }
});
$('downloadProject').addEventListener('click', async () => {
  const button = $('downloadProject'); button.disabled = true; button.textContent = 'Preparing project…';
  try {
    const response = await fetch('/api/workspace/export', { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Unable to download the project.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'codecraft-project.zip'; document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    showGlobal('Your project download has started.');
  } catch (err) { showNotice('chatError', err.message, 'error'); }
  finally { button.disabled = false; button.textContent = '↓ Download project'; }
});
