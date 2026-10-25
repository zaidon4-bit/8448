'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer-facing assets do not reveal the configured model or gateway', () => {
  const publicAssets = ['public/index.html', 'public/app.js', 'public/styles.css', 'public/yellow-cube-v3.html'].map(read).join('\n');
  assert.doesNotMatch(publicAssets, /gemini|odirouter|AI_API_KEY|AI_MODEL_ID|STRIPE_SECRET_KEY/i);
});

test('the working animation is present and embedded in the paid workspace', () => {
  const html = read('public/index.html');
  const animation = read('public/yellow-cube-v3.html');
  assert.match(html, /iframe src="\/yellow-cube-v3\.html"/);
  assert.match(animation, /يفكّر/);
  assert.match(animation, /ينفّذ/);
  assert.match(animation, /class=\"particles\"/);
  assert.match(animation, /background: transparent/);
});

test('OpenCode built-in tools, web search, and code intelligence use the supported config shape', () => {
  const server = read('server.js');
  assert.match(server, /permission: \{ '\*': 'allow' \}/);
  assert.match(server, /websearch: \{ provider: 'exa' \}/);
  assert.match(server, /lsp: true/);
  assert.match(server, /OPENCODE_ENABLE_EXA: '1'/);
  assert.match(server, /OPENCODE_EXPERIMENTAL_LSP_TOOL: 'true'/);
});

test('Docker installs OpenCode itself and verifies the executable at image build time', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /npm install --global opencode-ai/);
  assert.match(docker, /opencode --version/);
  assert.match(docker, /opencode serve --help/);
  assert.match(docker, /typescript-language-server/);
  assert.match(docker, /pyright/);
  assert.match(docker, /bash-language-server/);
  const server = read('server.js');
  assert.match(server, /spawn\('opencode', \['serve', '--hostname', '127\.0\.0\.1', '--port', String\(port\)\]/);
});

test('subscribed workspace is a distraction-free fullscreen chat with upload and download actions in the composer', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  assert.match(html, /id="chatInput"/);
  assert.match(html, /id="thinkingBox"/);
  assert.match(html, /id="uploadFiles"/);
  assert.match(html, /id="downloadProject"/);
  assert.match(css, /body\.in-workspace \.workspace\{position:fixed;inset:0/);
  assert.match(css, /body\.in-workspace \.workspace-sidebar\{display:none/);
});

test('the OpenCode prompt covers implementation, testing, and secret handling', () => {
  const prompt = read('opencode/system-prompt.txt');
  assert.match(prompt, /working software in the actual workspace/i);
  assert.match(prompt, /tests/i);
  assert.match(prompt, /Never reveal credentials/i);
  assert.match(prompt, /model providers/i);
});

test('subscription activation is webhook-based and signature checked', () => {
  const server = read('server.js');
  assert.match(server, /constructEvent\(req\.body, req\.get\('stripe-signature'\), secret\)/);
  assert.match(server, /customer\.subscription\.updated/);
  assert.match(server, /requireSubscription/);
});

test('Render configuration preserves data and exposes health check', () => {
  const render = read('render.yaml');
  assert.match(render, /mountPath: \/var\/data/);
  assert.match(render, /healthCheckPath: \/healthz/);
  assert.match(render, /STRIPE_WEBHOOK_SECRET/);
});

test('each subscriber is configured with a private workspace and separate worker UID', () => {
  const server = read('server.js');
  assert.match(server, /uidForUser\(userId\)/);
  assert.match(server, /WORKSPACES_DIR/);
  assert.match(server, /uid: identity\.uid/);
  assert.match(server, /mode: 0o700/);
});

test('admin panel assigns per-user API credentials without returning stored secrets', () => {
  const server = read('server.js');
  const html = read('public/admin.html');
  const js = read('public/admin.js');
  const render = read('render.yaml');
  assert.match(server, /aes-256-gcm/);
  assert.match(server, /APP_ENCRYPTION_KEY/);
  assert.match(server, /app\.get\('\/api\/admin\/users'/);
  assert.match(server, /app\.patch\('\/api\/admin\/users\/:id'/);
  assert.match(server, /function requireAdmin/);
  assert.match(server, /bootstrapAdminAccount\(\)/);
  assert.match(html, /id="apiKey"/);
  assert.match(js, /مفتاح محفوظ/);
  assert.match(render, /key: ADMIN_EMAIL/);
  assert.match(render, /key: ADMIN_PASSWORD/);
  assert.match(render, /key: APP_ENCRYPTION_KEY/);
  assert.doesNotMatch(server, /apiKey:\s*user\.ai_api_key_encrypted/);
});
