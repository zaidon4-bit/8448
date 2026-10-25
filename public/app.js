'use strict';

const $ = id => document.getElementById(id);
let authMode = 'register';
let currentUser = null;
let config = { productName: 'CodeCraft Studio', subscriptionPriceLabel: 'تفعيل يدوي بعد مراجعة الإدارة', assistantConfigured: false, paymentsConfigured: false, manualApprovalEnabled: true };
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
  if (!response.ok) throw new Error(payload.error || 'تعذّر إكمال الطلب. حاول مجدداً.');
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
function addMessage(role, content) {
  removeEmptyState();
  const wrap = document.createElement('article');
  wrap.className = `message ${role}`;
  const head = document.createElement('div'); head.className = 'message-head';
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? 'أنت' : '✦';
  const label = document.createElement('span'); label.textContent = role === 'user' ? 'أنت' : 'CodeCraft';
  head.append(avatar, label);
  const body = document.createElement('div'); body.className = 'message-body';
  renderMarkdownSafe(body, content);
  wrap.append(head, body); $('chatMessages').append(wrap); scrollChatToBottom();
}

function addToolActivity(tools) {
  const names = [...new Set((Array.isArray(tools) ? tools : []).filter(name => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name)))];
  if (!names.length) return;
  const row = document.createElement('div'); row.className = 'tool-activity';
  const icon = document.createElement('span'); icon.className = 'tool-activity-dot'; icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.textContent = `الأدوات المستخدمة: ${names.join(' · ')}`;
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
    $('subscriptionBadge').textContent = 'عضوية فعّالة';
    setView('workspace');
    loadHistory();
  } else {
    $('priceDisplay').textContent = config.subscriptionPriceLabel || 'تفعيل يدوي بعد مراجعة الإدارة';
    const requested = !!currentUser.subscriptionRequestedAt;
    const requestButton = $('requestActivationButton');
    if (requestButton) {
      requestButton.disabled = requested;
      requestButton.innerHTML = requested ? 'تم إرسال طلب المراجعة ✓' : 'طلب مراجعة وتفعيل الاشتراك <span>←</span>';
    }
    const statusText = $('membershipStatusText');
    if (statusText) statusText.textContent = requested
      ? 'طلبك قيد المراجعة. ستقوم الإدارة بتفعيل الاشتراك بعد التأكد.'
      : 'إذا أكملت الدفع بالطريقة المتفق عليها، أرسل طلب مراجعة؛ ستؤكد الإدارة الاشتراك يدوياً.';
    setView('membership');
  }
}
async function loadHistory() {
  const box = $('chatMessages');
  box.innerHTML = '<div id="emptyState" class="empty-state"><div class="empty-orbit"><span>⌘</span></div><h3>مساحة عملك جاهزة</h3><p>اكتب مهمة برمجية أو ارفع ملفات مشروعك لتعمل عليها داخل مساحة العمل الخاصة بك.</p></div>';
  try {
    const data = await request('/api/chat/history');
    if (data.messages && data.messages.length) {
      box.innerHTML = '';
      for (const m of data.messages) addMessage(m.role, m.content);
    }
  } catch (err) {
    if (!/اشتراك|سجّل الدخول/.test(err.message)) showGlobal(err.message, true);
  }
}
function setAuthMode(mode) {
  authMode = mode;
  $('authTitle').textContent = mode === 'register' ? 'أنشئ حسابك' : 'أهلاً بعودتك';
  $('registerTab').classList.toggle('active', mode === 'register');
  $('loginTab').classList.toggle('active', mode === 'login');
  $('authSubmit').innerHTML = mode === 'register' ? 'إنشاء الحساب <span>←</span>' : 'تسجيل الدخول <span>←</span>';
  $('authForm').querySelector('[name="password"]').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  $('authForm').querySelector('[name="password"]').setAttribute('minlength', mode === 'register' ? '10' : '1');
  $('authHint').textContent = mode === 'register' ? 'استخدم كلمة مرور قوية لا تستخدمها في موقع آخر.' : 'أدخل بيانات الحساب الذي أنشأته سابقاً.';
  hide($('authError'));
}
async function loadInitial() {
  try { config = await request('/api/config'); } catch {}
  $('priceDisplay').textContent = config.subscriptionPriceLabel || 'تفعيل يدوي بعد مراجعة الإدارة';
  try {
    const data = await request('/api/me');
    currentUser = data.user;
    renderUser();
  } catch { currentUser = null; renderUser(); }
}
async function refreshMembership(retry = false) {
  const button = $('refreshMembership');
  if (button) { button.disabled = true; button.textContent = 'جارٍ التحقق…'; }
  try {
    const tries = retry ? 4 : 1;
    for (let i = 0; i < tries; i++) {
      const data = await request('/api/me');
      currentUser = data.user;
      if (currentUser && currentUser.subscriptionActive) { renderUser(); showGlobal('تم تفعيل العضوية بنجاح.'); return; }
      if (i < tries - 1) await new Promise(resolve => setTimeout(resolve, 1600));
    }
    renderUser();
    const note = $('billingNote');
    showNotice(note, currentUser && currentUser.subscriptionRequestedAt ? 'طلبك ما زال قيد مراجعة الإدارة. حدّث الحالة لاحقاً.' : 'لم يُفعّل الاشتراك بعد. أرسل طلب مراجعة إذا أتممت الدفع بالطريقة المتفق عليها.', 'error');
  } catch (err) { showGlobal(err.message, true); }
  finally { if (button) { button.disabled = false; button.textContent = 'تحقق من حالة الاشتراك'; } }
}

$('heroStart').addEventListener('click', () => { setView(currentUser ? (currentUser.subscriptionActive ? 'workspace' : 'membership') : 'auth'); if (!currentUser) setAuthMode('register'); });
$('topLogin').addEventListener('click', () => { setView('auth'); setAuthMode('login'); });
$('registerTab').addEventListener('click', () => setAuthMode('register'));
$('loginTab').addEventListener('click', () => setAuthMode('login'));
$('authForm').addEventListener('submit', async event => {
  event.preventDefault(); hide($('authError'));
  const button = $('authSubmit'); button.disabled = true; button.textContent = 'جارٍ التحقق…';
  const form = new FormData(event.currentTarget);
  try {
    const data = await request(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    currentUser = data.user; event.currentTarget.reset(); renderUser(); showGlobal(authMode === 'register' ? 'تم إنشاء حسابك.' : 'تم تسجيل الدخول.');
  } catch (err) { showNotice('authError', err.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = authMode === 'register' ? 'إنشاء الحساب <span>←</span>' : 'تسجيل الدخول <span>←</span>'; }
});
$('topLogout').addEventListener('click', async () => {
  try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  currentUser = null; renderUser(); showGlobal('تم تسجيل الخروج.');
});
$('requestActivationButton').addEventListener('click', async () => {
  const button = $('requestActivationButton'); button.disabled = true;
  try {
    const data = await request('/api/billing/request-activation', { method: 'POST', body: '{}' });
    const refreshed = await request('/api/me'); currentUser = refreshed.user; renderUser();
    showNotice($('billingNote'), data.message || 'تم إرسال طلب مراجعة الاشتراك.', 'success');
  } catch (err) {
    showNotice($('billingNote'), err.message, 'error');
    button.disabled = false;
  }
});
$('refreshMembership').addEventListener('click', () => refreshMembership(false));
$('newChatButton').addEventListener('click', async () => {
  try { await request('/api/chat/new', { method: 'POST', body: '{}' }); $('chatMessages').innerHTML = '<div id="emptyState" class="empty-state"><div class="empty-orbit"><span>⌘</span></div><h3>مهمة جديدة</h3><p>اكتب الهدف المطلوب تنفيذه.</p></div>'; }
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
  show($('thinkingBox')); scrollChatToBottom();
  try {
    const data = await request('/api/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
    addMessage('assistant', data.answer);
    addToolActivity(data.toolsUsed);
  } catch (err) {
    showNotice('chatError', err.message, 'error');
    addMessage('assistant', 'لم أتمكن من إكمال هذه المحاولة. يمكنك إعادة الطلب بعد مراجعة الرسالة أعلاه.');
  } finally {
    hide($('thinkingBox')); $('chatInput').disabled = false; $('sendButton').disabled = false; resizeComposer(); $('chatInput').focus(); busy = false;
  }
});

loadInitial();

$('uploadFiles').addEventListener('click', () => $('projectFiles').click());
$('projectFiles').addEventListener('change', async event => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  if (files.length > 30) { showNotice('chatError', 'اختر 30 ملفاً أو أقل في كل عملية رفع.', 'error'); event.target.value = ''; return; }
  const form = new FormData();
  const paths = [];
  for (const file of files) {
    paths.push(file.webkitRelativePath || file.name);
    form.append('files', file, file.name);
  }
  form.append('paths', JSON.stringify(paths));
  const button = $('uploadFiles'); button.disabled = true; button.textContent = 'جارٍ رفع الملفات…';
  try {
    const data = await request('/api/workspace/upload', { method: 'POST', body: form });
    showGlobal(data.message || 'تم رفع الملفات إلى مساحة عملك.');
    if (data.skipped) showGlobal(`تم تخطي ${data.skipped} ملفاً حساساً أو غير مسموح به.`, true);
  } catch (err) { showNotice('chatError', err.message, 'error'); }
  finally { button.disabled = false; button.textContent = '＋ ملفات المشروع'; event.target.value = ''; }
});
$('downloadProject').addEventListener('click', async () => {
  const button = $('downloadProject'); button.disabled = true; button.textContent = 'جارٍ تجهيز المشروع…';
  try {
    const response = await fetch('/api/workspace/export', { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'تعذّر تنزيل المشروع.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'codecraft-project.zip'; document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    showGlobal('بدأ تنزيل نسخة من ملفات مشروعك.');
  } catch (err) { showNotice('chatError', err.message, 'error'); }
  finally { button.disabled = false; button.textContent = '↓ تنزيل المشروع'; }
});
