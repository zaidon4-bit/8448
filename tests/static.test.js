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
  assert.match(server, /permission: \{ '\*': 'allow', external_directory: 'deny' \}/);
  assert.match(server, /OPENCODE_ENABLE_EXA: '1'/);
  assert.match(server, /OPENCODE_EXPERIMENTAL_LSP_TOOL: 'true'/);
  assert.match(server, /mcp: getMcpConfigForUser\(user\)/);
  assert.match(server, /mode: 'subagent'/);
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

test('subscription approval is manual in the admin panel and gated server-side', () => {
  const server = read('server.js');
  const admin = read('public/admin.html');
  const adminJs = read('public/admin.js');
  const app = read('public/app.js');
  assert.match(server, /app\.post\('\/api\/admin\/users\/:id\/subscription', requireAuth, requireAdmin/);
  assert.match(server, /subscription_status = 'active', subscription_source = 'manual'/);
  assert.match(server, /subscription_requested_at = NULL/);
  assert.match(server, /rawDays < 1 \|\| rawDays > 3650/);
  assert.match(server, /end > Math\.floor\(Date\.now\(\) \/ 1000\)/);
  assert.match(server, /app\.post\('\/api\/billing\/request-activation', requireAuth/);
  assert.doesNotMatch(read('package.json'), /\"stripe\"/);
  assert.match(server, /function requireSubscription/);
  assert.match(admin, /id="activateSubscription"/);
  assert.match(admin, /id="deactivateSubscription"/);
  assert.match(adminJs, /updateSubscription\('activate'\)/);
  assert.match(app, /\/api\/billing\/request-activation/);
  assert.match(app, /ستؤكد الإدارة الاشتراك يدوياً/);
});

test('Render configuration preserves data and exposes health check', () => {
  const render = read('render.yaml');
  assert.match(render, /mountPath: \/var\/data/);
  assert.match(render, /healthCheckPath: \/healthz/);
  assert.match(render, /ADMIN_PASSWORD/);
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
  assert.match(html, /id="mcpConfig"/);
  assert.match(html, /id="clearMcp"/);
  assert.match(server, /ai_mcp_config_encrypted/);
  assert.match(server, /require\('\.\/mcp-config'\)/);
  assert.match(read('mcp-config.js'), /function validateMcpConfig/);
  assert.match(js, /clearMcpConfig: true/);
  assert.match(js, /مفتاح محفوظ/);
  assert.match(render, /key: ADMIN_EMAIL/);
  assert.match(render, /key: ADMIN_PASSWORD/);
  assert.match(render, /key: APP_ENCRYPTION_KEY/);
  assert.doesNotMatch(server, /apiKey:\s*user\.ai_api_key_encrypted/);
});


test('OpenCode native tools remain enabled while external directory reads stay within workspace', () => {
  const server = read('server.js');
  assert.match(server, /permission: \{ '\*': 'allow', external_directory: 'deny' \}/);
  assert.match(server, /OPENCODE_EXPERIMENTAL: 'true'/);
  assert.match(server, /mcp: getMcpConfigForUser\(user\)/);
  assert.match(server, /ai_mcp_config_encrypted/);
});

test('Bundled agent skills follow the OpenCode SKILL.md layout', () => {
  const skills = ['code-review', 'web-research', 'test-debugging'];
  for (const name of skills) {
    const content = read(`opencode/skills/${name}/SKILL.md`);
    assert.match(content, new RegExp(`name: ${name}`));
    assert.match(content, /description:/);
  }
  assert.match(read('server.js'), /seedUserSkills/);
});


test('chat displays safe tool-name activity summaries returned by OpenCode', () => {
  const client = read('public/app.js');
  const server = read('server.js');
  assert.match(client, /function addToolActivity/);
  assert.match(client, /addToolActivity\(data\.toolsUsed\)/);
  assert.match(server, /const toolsUsed = \[\.\.\.new Set/);
});


test('MCP config validator accepts secure remote and local definitions', () => {
  const { validateMcpConfig } = require('../mcp-config');
  const remote = validateMcpConfig(JSON.stringify({ docs: {
    type: 'remote', url: 'https://mcp.example.com/mcp', enabled: true,
    headers: { Authorization: 'Bearer placeholder' }, oauth: false, timeout: 12000
  } }));
  assert.equal(remote.docs.type, 'remote');
  assert.equal(remote.docs.oauth, false);
  const local = validateMcpConfig({ github: {
    type: 'local', command: ['npx', '-y', '@example/mcp'], enabled: true,
    environment: { API_TOKEN: 'placeholder' }
  } });
  assert.equal(local.github.type, 'local');
  assert.equal(local.github.command[0], 'npx');
});

test('MCP config validator rejects malformed, insecure production, and oversized settings', () => {
  const { validateMcpConfig } = require('../mcp-config');
  assert.throws(() => validateMcpConfig('{bad'), /MCP_CONFIG_INVALID_JSON/);
  assert.throws(() => validateMcpConfig({ local: { type: 'local', command: [] } }), /MCP_CONFIG_INVALID_COMMAND/);
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => validateMcpConfig({ remote: { type: 'remote', url: 'http://mcp.example.com' } }), /MCP_CONFIG_INVALID_URL/);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior;
  }
  assert.throws(() => validateMcpConfig(' '.repeat(24001)), /MCP_CONFIG_TOO_LARGE/);
});
