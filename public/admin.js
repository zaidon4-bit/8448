'use strict';
const $ = id => document.getElementById(id);
let users = [];
let selectedId = null;
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'تعذّر إكمال الطلب.');
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
function renderUsers() {
  const list = $('usersList'); list.replaceChildren();
  const q = $('userSearch').value.trim().toLowerCase();
  const shown = users.filter(user => user.email.toLowerCase().includes(q));
  if (!shown.length) { const empty = document.createElement('div'); empty.className = 'admin-empty'; empty.textContent = 'لا يوجد مستخدمون مطابقون.'; list.append(empty); return; }
  for (const user of shown) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `user-row${user.id === selectedId ? ' active' : ''}`;
    const info = document.createElement('div'); info.style.minWidth = '0';
    const email = document.createElement('div'); email.className = 'user-email'; email.textContent = user.email;
    const meta = document.createElement('div'); meta.className = 'user-meta';
    meta.append(pill(`#${user.id}`), pill(user.apiConfigured ? 'API مهيّأ' : 'API غير مهيّأ', user.apiConfigured ? 'good' : ''));
    meta.append(pill(user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing' ? 'اشتراك فعّال' : 'غير مشترك', user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing' ? 'good' : ''));
    if (user.isDisabled) meta.append(pill('موقوف', 'bad'));
    info.append(email, meta); button.append(info); button.addEventListener('click', () => selectUser(user.id)); list.append(button);
  }
}
function selectUser(id) {
  const user = users.find(item => item.id === Number(id)); if (!user) return;
  selectedId = user.id;
  $('selectedUserId').value = String(user.id);
  $('editorTitle').textContent = `إعداد المستخدم #${user.id}`;
  $('editorSubtitle').textContent = user.email;
  $('apiBaseUrl').value = user.apiBaseUrl || '';
  $('modelId').value = user.modelId || '';
  $('apiKey').value = '';
  $('mcpConfig').value = '';
  $('apiKey').placeholder = user.apiConfigured ? 'مفتاح محفوظ؛ أدخل مفتاحاً جديداً للاستبدال' : 'أدخل مفتاح API للمستخدم';
  $('isDisabled').checked = user.isDisabled;
  $('apiStatus').textContent = `${user.apiConfigured ? 'اتصال مخصص محفوظ' : 'لا يوجد اتصال مخصص'} · ${user.mcpConfigured ? 'MCP محفوظ' : 'لا يوجد MCP'}`;
  $('apiStatus').style.color = user.apiConfigured ? '#a7efd4' : '#a9b4cb';
  renderUsers();
}
async function loadUsers(keepNotice = false) {
  $('refreshUsers').disabled = true;
  try {
    const data = await api('/api/admin/users'); users = data.users || [];
    $('accessDenied').classList.add('hidden'); $('adminContent').classList.remove('hidden');
    renderUsers();
    if (selectedId && users.some(user => user.id === selectedId)) selectUser(selectedId);
    else if (users.length) selectUser(users[0].id);
    if (!keepNotice) $('adminNotice').classList.add('hidden');
  } catch (err) {
    if (/تسجيل الدخول|سجّل الدخول/i.test(err.message)) showAccessDenied('سجّل الدخول بحساب الإدارة، ثم ارجع إلى هذه الصفحة.');
    else if (/الإدارة فقط/.test(err.message)) showAccessDenied(err.message);
    else notice(err.message, true);
  } finally { $('refreshUsers').disabled = false; }
}
$('refreshUsers').addEventListener('click', () => loadUsers());
$('userSearch').addEventListener('input', renderUsers);
$('userConfigForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedId) return notice('اختر مستخدماً أولاً.', true);
  const button = $('saveUser'); button.disabled = true;
  const payload = {
    baseUrl: $('apiBaseUrl').value.trim(),
    modelId: $('modelId').value.trim(),
    isDisabled: $('isDisabled').checked
  };
  if ($('apiKey').value.trim()) payload.apiKey = $('apiKey').value.trim();
  if ($('mcpConfig').value.trim()) payload.mcpConfig = $('mcpConfig').value.trim();
  try {
    await api(`/api/admin/users/${selectedId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    $('apiKey').value = '';
    notice('تم حفظ إعدادات المستخدم. لم يتم عرض المفتاح المحفوظ مجدداً.');
    await loadUsers(true);
  } catch (err) { notice(err.message, true); }
  finally { button.disabled = false; }
});
$('clearApi').addEventListener('click', async () => {
  if (!selectedId) return notice('اختر مستخدماً أولاً.', true);
  if (!window.confirm('هل تريد مسح اتصال API المخصص لهذا المستخدم؟')) return;
  const button = $('clearApi'); button.disabled = true;
  try {
    await api(`/api/admin/users/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ clearApiConfig: true, isDisabled: $('isDisabled').checked }) });
    $('apiKey').value = ''; notice('تم مسح اتصال API المخصص. إذا كان هناك إعداد افتراضي على الخادم فسيظل متاحاً.'); await loadUsers(true);
  } catch (err) { notice(err.message, true); }
  finally { button.disabled = false; }
});
loadUsers();

$('clearMcp').addEventListener('click', async () => {
  if (!selectedId) return notice('اختر مستخدماً أولاً.', true);
  if (!window.confirm('هل تريد مسح خوادم MCP المحفوظة لهذا المستخدم؟')) return;
  const button = $('clearMcp'); button.disabled = true;
  try {
    await api(`/api/admin/users/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ clearMcpConfig: true, isDisabled: $('isDisabled').checked }) });
    $('mcpConfig').value = ''; notice('تم مسح إعداد MCP لهذا المستخدم.'); await loadUsers(true);
  } catch (err) { notice(err.message, true); }
  finally { button.disabled = false; }
});
