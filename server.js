'use strict';

const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');

process.umask(0o077);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'storage'));
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-only-secret-change-me-please');
const COOKIE_NAME = 'codecraft_session';
const OPENCODE_PORT_BASE = 4097;
const AI_PROXY_HOST = '127.0.0.1';
const AI_PROXY_PORT = Number(process.env.AI_PROXY_PORT || OPENCODE_PORT_BASE);
const DEFAULT_SYSTEM_PROMPT_PATH = path.join(__dirname, 'opencode', 'system-prompt.txt');
const SYSTEM_PROMPT_PATH = path.join(DATA_DIR, 'admin-system-prompt.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const HOMES_DIR = path.join(DATA_DIR, 'opencode-home');
const TEMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [DATA_DIR, WORKSPACES_DIR, HOMES_DIR, TEMP_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// Parent directories are searchable but not listable by workers. Individual
// user homes/workspaces remain mode 0700 and owned by their unique UID.
for (const dir of [DATA_DIR, WORKSPACES_DIR, HOMES_DIR, TEMP_DIR]) {
  try { fs.chmodSync(dir, 0o711); } catch {}
}
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
}

const DB_PATH = path.join(DATA_DIR, 'codecraft.sqlite');
const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch {}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    subscription_status TEXT NOT NULL DEFAULT 'inactive',
    subscription_source TEXT NOT NULL DEFAULT 'manual',
    subscription_requested_at TEXT,
    subscription_current_period_end INTEGER,
    opencode_session_id TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    ai_base_url TEXT,
    ai_model_id TEXT,
    ai_api_key_encrypted TEXT,
    reasoning_level TEXT,
    thinking_mode TEXT NOT NULL DEFAULT 'auto',
    thinking_budget INTEGER NOT NULL DEFAULT 8192,
    output_target INTEGER NOT NULL DEFAULT 5000,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id_id ON chat_messages(user_id, id);
`);
// Additive migrations keep databases created by earlier versions compatible.
const userColumns = new Set(db.pragma('table_info(users)').map(column => column.name));
for (const [name, definition] of Object.entries({
  is_admin: 'INTEGER NOT NULL DEFAULT 0',
  is_disabled: 'INTEGER NOT NULL DEFAULT 0',
  ai_base_url: 'TEXT',
  ai_model_id: 'TEXT',
  ai_api_key_encrypted: 'TEXT',
  reasoning_level: 'TEXT',
  thinking_mode: "TEXT NOT NULL DEFAULT 'auto'",
  thinking_budget: 'INTEGER NOT NULL DEFAULT 8192',
  output_target: 'INTEGER NOT NULL DEFAULT 5000',
  subscription_source: "TEXT NOT NULL DEFAULT 'manual'",
  subscription_requested_at: 'TEXT'
})) {
  if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}

const selectUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const selectUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const chatColumns = new Set(db.pragma('table_info(chat_messages)').map(column => column.name));
if (!chatColumns.has('metadata_json')) db.exec('ALTER TABLE chat_messages ADD COLUMN metadata_json TEXT');
const insertMessage = db.prepare('INSERT INTO chat_messages (user_id, role, content, metadata_json) VALUES (?, ?, ?, ?)');
const selectMessages = db.prepare('SELECT role, content, created_at, metadata_json FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?');

db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const getAppSettingStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const setAppSettingStmt = db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`);
function getAppSetting(key) {
  const row = getAppSettingStmt.get(key);
  return row ? row.value : null;
}
function setAppSetting(key, value) { setAppSettingStmt.run(key, String(value)); }
const defaultSystemPrompt = fs.readFileSync(DEFAULT_SYSTEM_PROMPT_PATH, 'utf8').trim();
if (getAppSetting('system_prompt') === null) setAppSetting('system_prompt', defaultSystemPrompt);
function syncRuntimeSystemPrompt() {
  const value = String(getAppSetting('system_prompt') || defaultSystemPrompt).trim();
  fs.writeFileSync(SYSTEM_PROMPT_PATH, `${value}\n`, { encoding: 'utf8', mode: 0o644 });
  fs.chmodSync(SYSTEM_PROMPT_PATH, 0o644);
}
syncRuntimeSystemPrompt();

function isActiveSubscription(user) {
  if (!user || !['active', 'trialing'].includes(user.subscription_status)) return false;
  const end = Number(user.subscription_current_period_end || 0);
  return !end || end > Math.floor(Date.now() / 1000);
}
function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    subscriptionStatus: user.subscription_status,
    subscriptionActive: isActiveSubscription(user),
    subscriptionCurrentPeriodEnd: user.subscription_current_period_end,
    subscriptionRequestedAt: user.subscription_requested_at || null,
    subscriptionSource: user.subscription_source || 'manual',
    isAdmin: user.is_admin === 1,
    accountDisabled: user.is_disabled === 1
  };
}
function getRequestOrigin(req) {
  if (APP_URL) return APP_URL;
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}`;
}
// The public web app never receives the model-provider key. The local reverse
// proxy injects it server-side. Each OpenCode worker receives only a per-user
// proxy token and runs under a separate Unix UID with a private workspace.
const proxyTokens = new Map();
const proxyRate = new Map();
const instances = new Map();
const instanceStartPromises = new Map();
let shuttingDown = false;

function encryptionKey() {
  const value = String(process.env.APP_ENCRYPTION_KEY || '');
  if (value.length < 32) throw new Error('APP_ENCRYPTION_KEY must be configured with at least 32 characters.');
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}
function encryptApiKey(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decryptApiKey(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Stored API credential format is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

function getAIConfigForUser(user) {
  if (user && user.ai_api_key_encrypted && user.ai_base_url && user.ai_model_id) {
    return { baseUrl: user.ai_base_url, modelId: user.ai_model_id, apiKey: decryptApiKey(user.ai_api_key_encrypted), source: 'user' };
  }
  if (process.env.AI_BASE_URL && process.env.AI_MODEL_ID && process.env.AI_API_KEY) {
    return { baseUrl: process.env.AI_BASE_URL, modelId: process.env.AI_MODEL_ID, apiKey: process.env.AI_API_KEY, source: 'default' };
  }
  return null;
}
function summarizeTokenUsage(info) {
  const usage = info && info.usage;
  const tokens = (info && info.tokens)
    || (usage && usage.opencode && usage.opencode.tokens)
    || (usage && usage.tokens)
    || (info && info.usageMetadata)
    || usage
    || null;
  if (!tokens || typeof tokens !== 'object') return null;
  const number = (...values) => {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
    }
    return null;
  };
  const input = number(tokens.input, tokens.prompt_tokens, tokens.input_tokens, tokens.promptTokenCount);
  const output = number(tokens.output, tokens.completion_tokens, tokens.output_tokens, tokens.candidatesTokenCount);
  const reasoning = number(tokens.reasoning, tokens.reasoning_tokens);
  const cacheRead = number(tokens.cache && tokens.cache.read, tokens.cache_read, tokens.cacheRead,
    tokens.cache_read_input_tokens, tokens.cachedContentTokenCount) || 0;
  const cacheWrite = number(tokens.cache && tokens.cache.write, tokens.cache_write,
    tokens.cache_write_5m, tokens.cache_write_1h) || 0;
  const reportedTotal = number(tokens.total, tokens.total_tokens, tokens.totalTokens);
  const hasNormalizedTokenBreakdown = tokens.input !== undefined || tokens.output !== undefined || tokens.cache !== undefined;
  const total = reportedTotal !== null
    ? reportedTotal
    : ((input !== null && output !== null)
        ? (input + output + (hasNormalizedTokenBreakdown ? cacheRead + cacheWrite : 0))
        : null);
  if (total === null && input === null && output === null && reasoning === null && !cacheRead && !cacheWrite) return null;
  return { total, input, output, reasoning: reasoning || 0, cacheRead, cacheWrite };
}

function aiConfigReady(user = null) {
  try { const config = getAIConfigForUser(user); return !!(config && config.baseUrl && config.modelId && config.apiKey); }
  catch { return false; }
}
function providerBaseUrl(config) {
  const value = String(config && config.baseUrl || '').trim();
  if (!value) throw new Error('AI provider configuration is incomplete');
  const parsed = new URL(value);
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('AI provider URL must use HTTPS in production');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('Unsupported AI provider URL');
  return parsed;
}
function getProviderTarget(requestUrl, config) {
  const base = providerBaseUrl(config);
  const basePath = base.pathname.replace(/\/+$/, '');
  const raw = String(requestUrl || '/');
  const qIndex = raw.indexOf('?');
  let pathname = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = qIndex >= 0 ? raw.slice(qIndex) : '';
  pathname = pathname.replace(/^\/v1(?=\/|$)/, '');
  const combined = `${basePath}/${pathname.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return new URL(`${combined}${query}`, base.origin);
}
function pruneBuckets(now) {
  for (const [key, item] of proxyRate) if (now - item.start > 120_000) proxyRate.delete(key);
}

const proxyServer = http.createServer((req, res) => {
  (async () => {
    if (!req.url || !req.url.startsWith('/v1/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"not_found"}');
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const userId = proxyTokens.get(token);
    if (!userId) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    const user = selectUserById.get(userId);
    if (!isActiveSubscription(user)) {
      res.writeHead(402, { 'content-type': 'application/json' });
      return res.end('{"error":"subscription_required"}');
    }
    if (user.is_disabled === 1) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end('{"error":"account_disabled"}');
    }
    let aiConfig;
    try { aiConfig = getAIConfigForUser(user); } catch { aiConfig = null; }
    if (!aiConfig) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"error":"ai_configuration_unavailable"}');
    }
    const now = Date.now();
    pruneBuckets(now);
    const bucketKey = String(userId);
    const bucket = proxyRate.get(bucketKey) || { start: now, count: 0 };
    if (now - bucket.start > 60_000) { bucket.start = now; bucket.count = 0; }
    bucket.count += 1;
    proxyRate.set(bucketKey, bucket);
    const requestLimit = Math.max(1, Number(process.env.AI_REQUESTS_PER_MINUTE || 30));
    if (bucket.count > requestLimit) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      return res.end('{"error":"rate_limit_exceeded"}');
    }

    const allowedPaths = new Set(['/v1/chat/completions', '/v1/models']);
    const requestPath = req.url.split('?')[0];
    if (!allowedPaths.has(requestPath)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"endpoint_not_available"}');
    }
    if (requestPath === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'code-assistant', object: 'model', created: 0, owned_by: 'CodeCraft' }] }));
    }
    let target;
    try { target = getProviderTarget(req.url, aiConfig); }
    catch { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"service_unavailable"}'); }
    const transport = target.protocol === 'https:' ? https : http;
    const chunks = [];
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > 12 * 1024 * 1024) req.destroy(new Error('request too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (requestPath === '/v1/chat/completions') {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          // The browser/agent sees only a neutral model alias. The server maps
          // that alias to the privately configured upstream model.
          parsed.model = aiConfig.modelId;
          // Per-user generation preferences. Google documents the OpenAI-compatible
          // `extra_body.google.thinking_config.thinking_budget` extension for Gemini 2.5.
          // -1 keeps dynamic thinking; an explicit budget uses the selected target.
          const thinkingMode = user && user.thinking_mode === 'budget' ? 'budget' : 'auto';
          const allowedBudgets = [4096, 8192, 16384, 24576, 32768];
          const thinkingBudget = allowedBudgets.includes(Number(user && user.thinking_budget))
            ? Number(user.thinking_budget) : 8192;
          const allowedOutputTargets = [2000, 5000, 10000, 20000];
          const outputTarget = allowedOutputTargets.includes(Number(user && user.output_target))
            ? Number(user.output_target) : 5000;
          const isGemini25Pro = /gemini[\s_\/-]*2\.?5[\s_\/-]*pro/i.test(aiConfig.modelId);
          const effectiveThinkingBudget = thinkingMode === 'budget' ? thinkingBudget : 8192;
          if (isGemini25Pro) {
            // Do not send reasoning_effort as well: Google documents these controls
            // as overlapping. Gateways which support Google's OpenAI-compat layer
            // should forward this provider-specific extension.
            delete parsed.reasoning_effort;
            parsed.extra_body = parsed.extra_body && typeof parsed.extra_body === 'object' && !Array.isArray(parsed.extra_body)
              ? parsed.extra_body : {};
            const google = parsed.extra_body.google && typeof parsed.extra_body.google === 'object'
              ? parsed.extra_body.google : {};
            const thinkingConfig = google.thinking_config && typeof google.thinking_config === 'object'
              ? google.thinking_config : {};
            parsed.extra_body.google = {
              ...google,
              thinking_config: { ...thinkingConfig, thinking_budget: thinkingMode === 'budget' ? thinkingBudget : -1 }
            };
          }
          // Gemini's max-output limit includes thought tokens, so reserve room for
          // both the selected user-facing answer target and the thinking budget.
          // A target is guidance/allowance, never a guaranteed minimum response.
          const maxAllowed = Math.min(65536, outputTarget + (isGemini25Pro ? effectiveThinkingBudget : 0));
          if (Object.prototype.hasOwnProperty.call(parsed, 'max_completion_tokens')) {
            parsed.max_completion_tokens = maxAllowed;
            delete parsed.max_tokens;
          } else {
            parsed.max_tokens = maxAllowed;
          }
          const lengthInstruction = `User response-length preference: for substantial coding tasks, aim for approximately ${outputTarget.toLocaleString('en-US')} output tokens when needed for code, files, or a detailed explanation. This is a target/allowance, not a minimum guarantee. Keep greetings and simple questions concise; never pad the answer, invent content, or omit required implementation and verification.`;
          if (Array.isArray(parsed.messages)) {
            const systemMessage = parsed.messages.find(message => message && ['system', 'developer'].includes(message.role));
            if (!systemMessage) parsed.messages.unshift({ role: 'system', content: lengthInstruction });
            else if (typeof systemMessage.content === 'string') systemMessage.content += `\n\n${lengthInstruction}`;
            else if (Array.isArray(systemMessage.content)) systemMessage.content.push({ type: 'text', text: lengthInstruction });
          }
          body = Buffer.from(JSON.stringify(parsed));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"error":"invalid_request"}');
        }
      }
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers['proxy-authorization'];
      delete headers.cookie;
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      headers.authorization = `Bearer ${aiConfig.apiKey}`;
      headers.host = target.host;
      headers['accept-encoding'] = 'identity';
      if (body.length) headers['content-length'] = String(body.length);
      const upstreamReq = transport.request(target, { method: req.method, headers, timeout: 300_000 }, upstreamRes => {
        if ((upstreamRes.statusCode || 500) >= 400) {
          upstreamRes.resume();
          res.writeHead(upstreamRes.statusCode || 502, {
            'content-type': 'application/json',
            ...(upstreamRes.headers['retry-after'] ? { 'retry-after': upstreamRes.headers['retry-after'] } : {})
          });
          return res.end(JSON.stringify({ error: { message: 'The coding service could not complete this request.', type: 'service_error' } }));
        }
        res.writeHead(upstreamRes.statusCode || 502, {
          'content-type': upstreamRes.headers['content-type'] || 'application/json',
          ...(upstreamRes.headers['cache-control'] ? { 'cache-control': upstreamRes.headers['cache-control'] } : {}),
          ...(upstreamRes.headers['retry-after'] ? { 'retry-after': upstreamRes.headers['retry-after'] } : {}),
          ...(upstreamRes.headers['x-request-id'] ? { 'x-request-id': upstreamRes.headers['x-request-id'] } : {})
        });
        upstreamRes.pipe(res);
      });
      upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
      upstreamReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end('{"error":"provider_unavailable"}');
      });
      upstreamReq.end(body);
    });
  })().catch(() => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end('{"error":"internal_error"}');
  });
});

function uidForUser(userId) { return 100000 + Number(userId); }
function usernameForUser(userId) { return `ocuser${Number(userId)}`; }
function runSystemCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim().slice(0, 500);
    throw new Error(`${command} failed${details ? `: ${details}` : ''}`);
  }
  return result.stdout;
}
function ensureUnixIdentity(userId, uid, homeDir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    // Local development fallback. Production Docker runs the manager as root,
    // then launches each coding worker under a unique UID.
    return { uid: typeof process.getuid === 'function' ? process.getuid() : 1000, gid: typeof process.getgid === 'function' ? process.getgid() : 1000 };
  }
  const username = usernameForUser(userId);
  const lookup = spawnSync('getent', ['passwd', username], { encoding: 'utf8' });
  if (lookup.status !== 0) runSystemCommand('useradd', ['--no-log-init', '--uid', String(uid), '--user-group', '--no-create-home', '--home-dir', homeDir, '--shell', '/usr/sbin/nologin', username]);
  const entry = spawnSync('getent', ['passwd', username], { encoding: 'utf8' });
  const fields = String(entry.stdout || '').trim().split(':');
  if (entry.status !== 0 || Number(fields[2]) !== uid) throw new Error('Unable to initialize isolated worker identity');
  const gid = Number(fields[3]);
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.chownSync(homeDir, uid, gid);
  fs.chmodSync(homeDir, 0o700);
  return { uid, gid };
}
function secureOwnTree(root, uid, gid) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  fs.chownSync(root, uid, gid);
  fs.chmodSync(root, 0o700);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    fs.chownSync(full, uid, gid);
    if (stat.isDirectory()) secureOwnTree(full, uid, gid);
    else fs.chmodSync(full, (stat.mode & 0o111) ? 0o700 : 0o600);
  }
}
function seedWorkspaceFile(destination, content) {
  // O_EXCL plus O_NOFOLLOW prevents an upload/tool-created symlink from making
  // this root-owned setup step write outside the new workspace.
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

function seedUserSkills(homeDir, uid, gid) {
  const bundledRoot = path.join(__dirname, 'opencode', 'skills');
  if (!fs.existsSync(bundledRoot)) return;
  // Walk each directory without following symlinks because the worker owns its HOME.
  let current = homeDir;
  for (const segment of ['.config', 'opencode', 'skills']) {
    current = path.join(current, segment);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Unsafe skill directory path');
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    fs.chownSync(current, uid, gid);
    fs.chmodSync(current, 0o700);
  }
  for (const skillName of fs.readdirSync(bundledRoot)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) continue;
    const sourceDir = path.join(bundledRoot, skillName);
    const sourceFile = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(sourceFile) || !fs.statSync(sourceDir).isDirectory()) continue;
    const destDir = path.join(current, skillName);
    try {
      const st = fs.lstatSync(destDir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Unsafe skill directory path');
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      fs.mkdirSync(destDir, { mode: 0o700 });
    }
    fs.chownSync(destDir, uid, gid); fs.chmodSync(destDir, 0o700);
    const destFile = path.join(destDir, 'SKILL.md');
    const created = seedWorkspaceFile(destFile, fs.readFileSync(sourceFile, 'utf8'));
    // Only chown a file we just created; never follow or modify a user-owned existing path.
    if (created) { fs.chownSync(destFile, uid, gid); fs.chmodSync(destFile, 0o600); }
  }
}
function writeUserPromptFiles(userId, uid, gid, workspace, isNewWorkspace) {
  // System prompt and model configuration are supplied through a higher-
  // precedence inline config in the worker environment and live in /app,
  // which is root-owned/read-only to workers. Never write config into a
  // subscriber-controlled HOME directory as root.
  if (isNewWorkspace) {
    seedWorkspaceFile(path.join(workspace, 'AGENTS.md'), `# Project instructions\n\nInspect the project before edits. Implement real changes, test them, preserve unrelated work, keep secrets out of source control, and report only verified results. The service-wide coding rules are always applied separately.\n`);
    seedWorkspaceFile(path.join(workspace, 'README.md'), '# My coding workspace\n\nYour project files live here. Ask the coding assistant to inspect this workspace and help build your project.\n');
  }
  secureOwnTree(workspace, uid, gid);
  try { fs.chownSync(workspace, uid, gid); fs.chmodSync(workspace, 0o700); } catch {}
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(err => err ? reject(err) : resolve(port));
    });
  });
}
function openCodeHeaders(password) {
  return { authorization: `Basic ${Buffer.from(`internal:${password}`).toString('base64')}`, 'content-type': 'application/json' };
}
async function openCodeFetch(instance, route, options = {}) {
  const separator = route.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:${instance.port}${route}${separator}directory=${encodeURIComponent(instance.workspace)}`;
  return fetch(url, {
    ...options,
    headers: { ...openCodeHeaders(instance.password), ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(600_000)
  });
}
async function waitForOpenCode(instance, child) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('OpenCode server exited during startup');
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/global/health`, {
        headers: openCodeHeaders(instance.password), signal: AbortSignal.timeout(1_500)
      });
      if (response.ok) return;
    } catch { /* server still starting */ }
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  throw new Error('OpenCode server did not become ready');
}
async function ensureOpenCodeForUser(user) {
  const inFlight = instanceStartPromises.get(user.id);
  if (inFlight) return inFlight;
  const promise = startOpenCodeForUser(user);
  instanceStartPromises.set(user.id, promise);
  try { return await promise; }
  finally { if (instanceStartPromises.get(user.id) === promise) instanceStartPromises.delete(user.id); }
}
async function startOpenCodeForUser(user) {
  if (!aiConfigReady(user)) throw new Error('AI service is not configured for this account');
  const existing = instances.get(user.id);
  const maxInstances = Math.max(1, Number(process.env.MAX_ACTIVE_OPENCODE_INSTANCES || 12));
  if ((!existing || existing.child.exitCode !== null) && instances.size >= maxInstances) {
    const idle = [...instances.values()].filter(instance => !instance.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    if (idle.length) stopInstance(idle[0].userId);
    else throw new Error('Coding service is busy');
  }
  if (existing && existing.child.exitCode === null && existing.ready) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) stopInstance(user.id);
  const uid = uidForUser(user.id);
  const workspace = path.join(WORKSPACES_DIR, String(user.id));
  const homeDir = path.join(HOMES_DIR, String(user.id));
  const isNewWorkspace = !fs.existsSync(workspace);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const identity = ensureUnixIdentity(user.id, uid, homeDir);
  seedUserSkills(homeDir, identity.uid, identity.gid);
  if (isNewWorkspace) {
    writeUserPromptFiles(user.id, identity.uid, identity.gid, workspace, true);
  } else {
    fs.chownSync(workspace, identity.uid, identity.gid);
    fs.chmodSync(workspace, 0o700);
    writeUserPromptFiles(user.id, identity.uid, identity.gid, workspace, false);
  }
  const port = await freePort();
  const password = crypto.randomBytes(24).toString('hex');
  const proxyToken = crypto.randomBytes(32).toString('hex');
  proxyTokens.set(proxyToken, user.id);
  const tempHome = path.join(TEMP_DIR, String(user.id));
  fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
  fs.chownSync(tempHome, identity.uid, identity.gid);
  fs.chmodSync(tempHome, 0o700);
  const childEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: homeDir,
    USER: usernameForUser(user.id),
    LOGNAME: usernameForUser(user.id),
    TMPDIR: tempHome,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    NODE_ENV: 'production',
    OPENCODE_ENABLE_EXA: '1',
    OPENCODE_EXPERIMENTAL_LSP_TOOL: 'true',
    OPENCODE_EXPERIMENTAL: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: { managed: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Code Assistant',
        options: { baseURL: `http://${AI_PROXY_HOST}:${AI_PROXY_PORT}/v1`, apiKey: '{env:AI_PROXY_TOKEN}' },
        models: { 'code-assistant': { name: 'Code Assistant' } }
      } },
      model: 'managed/code-assistant',
      default_agent: 'build',
      // Keep the complete built-in toolset available. Prevent cross-workspace file tools;
      // each subscriber gets a private Unix identity and workspace.
      permission: { '*': 'allow', external_directory: 'deny' },
      agent: {
        build: { mode: 'primary', prompt: `{file:${SYSTEM_PROMPT_PATH}}` },
        reviewer: { mode: 'subagent', description: 'Review code for correctness, security, regressions, and maintainability.', prompt: 'Review the current changes critically. Do not modify files. Identify concrete bugs, security issues, missing tests, and regressions. Return findings first, ordered by severity, and cite file paths and lines where possible.', permission: { '*': 'allow', edit: 'deny', bash: 'allow', external_directory: 'deny' } },
        tester: { mode: 'subagent', description: 'Run and diagnose relevant tests and builds.', prompt: 'Inspect project scripts and test setup, then run relevant checks. You may make minimal test-focused fixes only when explicitly asked by the parent task. Report exact commands and actual results; never invent success.', permission: { '*': 'allow', external_directory: 'deny' } },
        researcher: { mode: 'subagent', description: 'Research current technical documentation and compare solutions.', prompt: 'Use websearch to discover current primary documentation and webfetch to read relevant official pages. Cite source URLs and distinguish verified facts from inference. Do not modify files.', permission: { '*': 'allow', edit: 'deny', bash: 'deny', external_directory: 'deny' } }
      }
    }),
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'internal',
    AI_PROXY_TOKEN: proxyToken
  };
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: workspace,
    uid: identity.uid,
    gid: identity.gid,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderrTail = '';
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-6000); });
  child.stdout.on('data', () => {});
  const instance = { userId: user.id, uid: identity.uid, gid: identity.gid, workspace, homeDir, port, password, proxyToken, child, ready: false, busy: true, lastUsedAt: Date.now(), stderrTail: () => stderrTail };
  instances.set(user.id, instance);
  child.on('exit', (code, signal) => {
    if (instances.get(user.id) === instance) {
      instances.delete(user.id);
      proxyTokens.delete(proxyToken);
      if (!shuttingDown) console.error(`OpenCode worker stopped for user ${user.id} (code=${code}, signal=${signal}).`);
    }
  });
  try {
    await waitForOpenCode(instance, child);
    instance.ready = true;
    instance.busy = false;
    return instance;
  } catch (err) {
    console.error(`OpenCode worker startup failed for user ${user.id}: ${String(err.message)} ${stderrTail.slice(-1000)}`);
    stopInstance(user.id);
    throw new Error('Coding service is temporarily unavailable');
  }
}
function stopInstance(userId) {
  const instance = instances.get(userId);
  if (!instance) return;
  instances.delete(userId);
  proxyTokens.delete(instance.proxyToken);
  instance.ready = false;
  if (instance.child && instance.child.exitCode === null) instance.child.kill('SIGTERM');
  setTimeout(() => {
    if (instance.child && instance.child.exitCode === null) instance.child.kill('SIGKILL');
  }, 4_000).unref();
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    // Revalidate UI files after deployment so mobile browsers do not keep a stale Arabic/old bundle.
    if (/\.(?:html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

function originGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).origin !== new URL(getRequestOrigin(req)).origin) {
      return res.status(403).json({ error: 'Request blocked for security reasons. Reload the page and try again.' });
    }
  } catch {
    return res.status(403).json({ error: 'Unable to verify the request origin.' });
  }
  next();
}
app.use(express.json({ limit: '2mb' }));
app.use(originGuard);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: req => String(req.authUser.id) });

function attachAuth(req, res, next) {
  const token = req.cookiesToken || parseCookie(req.headers.cookie || '', COOKIE_NAME);
  if (!token) { req.authUser = null; return next(); }
  try {
    const payload = jwt.verify(token, SESSION_SECRET, { issuer: 'codecraft-membership' });
    req.authUser = selectUserById.get(Number(payload.sub)) || null;
  } catch { req.authUser = null; }
  next();
}
function parseCookie(cookieHeader, name) {
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}
function requireAuth(req, res, next) {
  attachAuth(req, res, () => {
    if (!req.authUser) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (req.authUser.is_disabled === 1) return res.status(403).json({ error: 'This account is disabled. Contact support.' });
    next();
  });
}
function requireSubscription(req, res, next) {
  if (!isActiveSubscription(req.authUser)) return res.status(402).json({ error: 'An active subscription is required to use the assistant.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.authUser || req.authUser.is_admin !== 1) return res.status(403).json({ error: 'This page is restricted to administrators.' });
  next();
}
function setSessionCookie(res, userId) {
  const token = jwt.sign({ sub: String(userId) }, SESSION_SECRET, { expiresIn: '7d', issuer: 'codecraft-membership' });
  res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
}
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function bootstrapAdminAccount() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) return;
  if (!validEmail(email) || Buffer.byteLength(password, 'utf8') < 14 || Buffer.byteLength(password, 'utf8') > 72) {
    console.error('Admin bootstrap skipped: set a valid ADMIN_EMAIL and an ADMIN_PASSWORD of 14-72 bytes.');
    return;
  }
  const passwordHash = bcrypt.hashSync(password, 12);
  const existing = selectUserByEmail.get(email);
  if (existing) db.prepare('UPDATE users SET password_hash = ?, is_admin = 1, is_disabled = 0 WHERE id = ?').run(passwordHash, existing.id);
  else db.prepare('INSERT INTO users(email, password_hash, is_admin) VALUES(?, ?, 1)').run(email, passwordHash);
}
bootstrapAdminAccount();

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, service: 'codecraft' }));
app.get('/api/config', (req, res) => res.json({
  productName: process.env.PRODUCT_NAME || 'CodeCraft Studio',
  subscriptionPriceLabel: process.env.SUBSCRIPTION_DISPLAY_PRICE || 'Manual activation after administrator review',
  subscriptionApprovalMode: 'manual',
  manualApprovalEnabled: true,
  assistantConfigured: aiConfigReady(),
  paymentsConfigured: false
}));
app.get('/api/me', (req, res) => {
  attachAuth(req, res, () => res.json({ user: req.authUser ? serializeUser(req.authUser) : null }));
});
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    systemPrompt: getAppSetting('system_prompt') || defaultSystemPrompt,
    defaultSystemPrompt
  });
});
app.patch('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : null;
  if (systemPrompt !== null && (!systemPrompt || systemPrompt.length > 40000)) {
    return res.status(400).json({ error: 'System Prompt must contain 1 to 40,000 characters.' });
  }
  const previousPrompt = getAppSetting('system_prompt') || defaultSystemPrompt;
  if (systemPrompt !== null) setAppSetting('system_prompt', systemPrompt);
  try {
    if (systemPrompt !== null && systemPrompt !== previousPrompt) {
      syncRuntimeSystemPrompt();
      // Workers read the system prompt when their configuration starts. Restart
      // them so the admin's prompt applies to subsequent requests.
      for (const userId of [...instances.keys()]) stopInstance(userId);
    }
  } catch (err) {
    console.error('Could not sync administrator System Prompt:', err.message);
    return res.status(500).json({ error: 'Could not save the System Prompt to persistent storage.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, promptUpdated: systemPrompt !== null && systemPrompt !== previousPrompt });
});
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT id, email, is_admin, is_disabled, subscription_status, subscription_source,
    subscription_requested_at, subscription_current_period_end, ai_base_url, ai_model_id, ai_api_key_encrypted, created_at
    FROM users ORDER BY id DESC LIMIT 500`).all().map(user => ({
      id: user.id,
      email: user.email,
      isAdmin: user.is_admin === 1,
      isDisabled: user.is_disabled === 1,
      subscriptionStatus: user.subscription_status,
      subscriptionActive: isActiveSubscription(user),
      subscriptionSource: user.subscription_source || 'manual',
      subscriptionRequestedAt: user.subscription_requested_at || null,
      subscriptionCurrentPeriodEnd: user.subscription_current_period_end,
      apiConfigured: !!(user.ai_base_url && user.ai_model_id && user.ai_api_key_encrypted),
      assistantConfigured: aiConfigReady(user),
      apiBaseUrl: user.ai_base_url || '',
      modelId: user.ai_model_id || '',
      createdAt: user.created_at
    }));
  res.set('Cache-Control', 'no-store');
  res.json({ users });
});
app.post('/api/admin/users/:id/subscription', requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
  const user = selectUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const action = String((req.body && req.body.action) || '');
  if (!['activate', 'deactivate'].includes(action)) return res.status(400).json({ error: 'Invalid membership action.' });

  if (action === 'activate') {
    const rawDays = req.body && req.body.days !== undefined ? Number(req.body.days) : 30;
    if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 3650) {
      return res.status(400).json({ error: 'Membership duration must be between 1 and 3650 days.' });
    }
    const endAt = Math.floor(Date.now() / 1000) + rawDays * 86400;
    db.prepare(`UPDATE users SET subscription_status = 'active', subscription_source = 'manual',
      subscription_current_period_end = ?, subscription_requested_at = NULL WHERE id = ?`).run(endAt, userId);
    stopInstance(userId);
    const updated = selectUserById.get(userId);
    return res.json({ ok: true, user: { id: updated.id, email: updated.email,
      subscriptionStatus: updated.subscription_status, subscriptionActive: isActiveSubscription(updated),
      subscriptionSource: updated.subscription_source, subscriptionCurrentPeriodEnd: updated.subscription_current_period_end,
      subscriptionRequestedAt: updated.subscription_requested_at } });
  }

  db.prepare(`UPDATE users SET subscription_status = 'inactive', subscription_source = 'manual',
    subscription_current_period_end = NULL, subscription_requested_at = NULL WHERE id = ?`).run(userId);
  stopInstance(userId);
  const updated = selectUserById.get(userId);
  res.json({ ok: true, user: { id: updated.id, email: updated.email,
    subscriptionStatus: updated.subscription_status, subscriptionActive: isActiveSubscription(updated),
    subscriptionSource: updated.subscription_source, subscriptionCurrentPeriodEnd: updated.subscription_current_period_end,
    subscriptionRequestedAt: updated.subscription_requested_at } });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
  const user = selectUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const body = req.body || {};
  const isDisabled = typeof body.isDisabled === 'boolean' ? Number(body.isDisabled) : user.is_disabled;
  if (userId === req.authUser.id && isDisabled === 1) return res.status(400).json({ error: 'You cannot disable the administrator account currently in use.' });
  let baseUrl = user.ai_base_url || '';
  let modelId = user.ai_model_id || '';
  let encryptedKey = user.ai_api_key_encrypted || null;
  if (body.clearApiConfig === true) {
    baseUrl = ''; modelId = ''; encryptedKey = null;
  } else {
    if (body.baseUrl !== undefined) baseUrl = String(body.baseUrl || '').trim();
    if (body.modelId !== undefined) modelId = String(body.modelId || '').trim();
    const rawKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (rawKey) {
      if (rawKey.length > 2000) return res.status(400).json({ error: 'The API key is longer than the allowed limit.' });
      if (!baseUrl || !modelId) return res.status(400).json({ error: 'Enter the API base URL and model ID along with the API key.' });
      if (modelId.length > 200) return res.status(400).json({ error: 'The model ID is too long.' });
      try {
        const parsed = new URL(baseUrl);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:')) throw new Error('invalid url');
        baseUrl = parsed.toString().replace(/\/+$/, '');
        encryptedKey = encryptApiKey(rawKey);
      } catch (err) {
        const message = err && err.message && /APP_ENCRYPTION_KEY/.test(err.message)
          ? 'Server-side credential encryption is not configured.'
          : 'Invalid API URL. Use a valid HTTPS URL.';
        return res.status(400).json({ error: message });
      }
    } else if (!encryptedKey) {
      if (baseUrl && process.env.NODE_ENV === 'production' && !/^https:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Use an HTTPS URL in production.' });
      if (modelId.length > 200) return res.status(400).json({ error: 'The model ID is too long.' });
    }
    if (encryptedKey && (!baseUrl || !modelId)) return res.status(400).json({ error: 'The API URL and model ID cannot be blank while an API key is saved.' });
  }
  db.prepare('UPDATE users SET is_disabled = ?, ai_base_url = ?, ai_model_id = ?, ai_api_key_encrypted = ? WHERE id = ?')
    .run(isDisabled, baseUrl || null, modelId || null, encryptedKey, userId);
  stopInstance(userId);
  const updated = selectUserById.get(userId);
  res.set('Cache-Control', 'no-store');
  res.json({ user: { id: updated.id, email: updated.email, isDisabled: updated.is_disabled === 1,
    apiConfigured: !!(updated.ai_base_url && updated.ai_model_id && updated.ai_api_key_encrypted),
    apiBaseUrl: updated.ai_base_url || '', modelId: updated.ai_model_id || '' } });
});
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = String(req.body && req.body.password || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Password must be at least 10 characters and no more than 72 bytes.' });
  if (selectUserByEmail.get(email)) return res.status(409).json({ error: 'This email is already registered. Please sign in instead.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users(email, password_hash) VALUES(?, ?)').run(email, hash);
    // Registration intentionally does not sign the user in. The client returns
    // to the sign-in form, where the new credentials are verified explicitly.
    res.status(201).json({ created: true, message: 'Account created. Please sign in to continue.' });
  } catch (err) {
    if (String(err.code) === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'This email is already registered.' });
    console.error('Registration failed:', err.message);
    res.status(500).json({ error: 'Unable to create the account right now. Please try again.' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = String(req.body && req.body.password || '');
  const user = selectUserByEmail.get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  setSessionCookie(res, user.id);
  res.json({ user: serializeUser(user) });
});
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});

app.post('/api/billing/request-activation', requireAuth, (req, res) => {
  const user = selectUserById.get(req.authUser.id);
  if (isActiveSubscription(user)) return res.status(409).json({ error: 'Your subscription is already active.' });
  db.prepare(`UPDATE users SET subscription_requested_at = COALESCE(subscription_requested_at, CURRENT_TIMESTAMP),
    subscription_source = 'manual' WHERE id = ?`).run(user.id);
  const updated = selectUserById.get(user.id);
  res.status(202).json({ ok: true, subscriptionRequestedAt: updated.subscription_requested_at,
    message: 'Your activation request has been submitted. An administrator will review and activate it manually.' });
});

app.post('/api/billing/checkout', requireAuth, (req, res) => {
  res.status(410).json({ error: 'Subscription approval is handled manually in the admin panel. Request activation from the membership page.' });
});
app.post('/api/billing/portal', requireAuth, (req, res) => {
  res.status(410).json({ error: 'Subscription management is handled manually by an administrator.' });
});

const ALLOWED_THINKING_BUDGETS = [4096, 8192, 16384, 24576, 32768];
const ALLOWED_OUTPUT_TARGETS = [2000, 5000, 10000, 20000];
function userPreferencePayload(user) {
  return {
    thinkingMode: user && user.thinking_mode === 'budget' ? 'budget' : 'auto',
    thinkingBudget: ALLOWED_THINKING_BUDGETS.includes(Number(user && user.thinking_budget)) ? Number(user.thinking_budget) : 8192,
    outputTarget: ALLOWED_OUTPUT_TARGETS.includes(Number(user && user.output_target)) ? Number(user.output_target) : 5000,
    thinkingBudgets: ALLOWED_THINKING_BUDGETS,
    outputTargets: ALLOWED_OUTPUT_TARGETS,
    note: 'Automatic mode lets the model choose its reasoning budget. Custom thinking budgets depend on support from the configured model connection. Answer targets guide the response but cannot guarantee a minimum token count.'
  };
}
app.get('/api/user/preferences', requireAuth, requireSubscription, (req, res) => {
  const user = selectUserById.get(req.authUser.id);
  res.set('Cache-Control', 'no-store');
  res.json(userPreferencePayload(user));
});
app.patch('/api/user/preferences', requireAuth, requireSubscription, (req, res) => {
  const body = req.body || {};
  const user = selectUserById.get(req.authUser.id);
  const thinkingMode = body.thinkingMode === undefined
    ? (user && user.thinking_mode === 'budget' ? 'budget' : 'auto')
    : String(body.thinkingMode).trim().toLowerCase();
  const thinkingBudget = body.thinkingBudget === undefined
    ? (ALLOWED_THINKING_BUDGETS.includes(Number(user && user.thinking_budget)) ? Number(user.thinking_budget) : 8192)
    : Number(body.thinkingBudget);
  const outputTarget = body.outputTarget === undefined
    ? (ALLOWED_OUTPUT_TARGETS.includes(Number(user && user.output_target)) ? Number(user.output_target) : 5000)
    : Number(body.outputTarget);
  if (!['auto', 'budget'].includes(thinkingMode)) return res.status(400).json({ error: 'Thinking mode must be auto or budget.' });
  if (!ALLOWED_THINKING_BUDGETS.includes(thinkingBudget)) return res.status(400).json({ error: 'Choose a supported thinking budget.' });
  if (!ALLOWED_OUTPUT_TARGETS.includes(outputTarget)) return res.status(400).json({ error: 'Choose a supported long-answer target.' });
  db.prepare('UPDATE users SET thinking_mode = ?, thinking_budget = ?, output_target = ? WHERE id = ?')
    .run(thinkingMode, thinkingBudget, outputTarget, req.authUser.id);
  const updated = selectUserById.get(req.authUser.id);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ...userPreferencePayload(updated) });
});

// User-created OpenCode skills are stored in each worker's private HOME, where
// OpenCode automatically discovers ~/.config/opencode/skills/<id>/SKILL.md.
function skillSlugFromName(name) {
  return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
}
function resolveUserSkillRoot(homeDir, create = false, uid = null, gid = null) {
  let current = homeDir;
  for (const segment of ['.config', 'opencode', 'skills']) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe user skill directory.');
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      if (!create) return null;
      fs.mkdirSync(current, { mode: 0o700 });
      if (uid !== null && gid !== null) fs.chownSync(current, uid, gid);
      fs.chmodSync(current, 0o700);
    }
  }
  return current;
}
function readCustomSkills(homeDir) {
  const root = resolveUserSkillRoot(homeDir, false);
  if (!root) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name))
    .map(entry => {
      const directory = path.join(root, entry.name);
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
      const file = path.join(directory, 'SKILL.md');
      let content;
      try {
        const fileStat = fs.lstatSync(file);
        if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > 16000) return null;
        content = fs.readFileSync(file, 'utf8');
      } catch { return null; }
      const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
      if (!match) return null;
      const field = key => {
        const line = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        if (!line) return '';
        try { return JSON.parse(line[1]); } catch { return line[1].replace(/^['"]|['"]$/g, ''); }
      };
      return { id: entry.name, name: String(field('name') || entry.name), description: String(field('description') || ''), created: directoryStat.mtime.toISOString() };
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
const skillChangeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: req => String(req.authUser.id) });
app.get('/api/user/skills', requireAuth, requireSubscription, (req, res) => {
  const homeDir = path.join(HOMES_DIR, String(req.authUser.id));
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ skills: readCustomSkills(homeDir), maxSkills: 20 });
  } catch (err) {
    console.error(`Unable to list skills for user ${req.authUser.id}: ${err.message}`);
    res.status(500).json({ error: 'Could not load your skills safely.' });
  }
});
app.post('/api/user/skills', requireAuth, requireSubscription, skillChangeLimiter, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const instructions = String(body.instructions || '').trim();
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Skill name must contain 2–60 characters.' });
  if (description.length < 10 || description.length > 300) return res.status(400).json({ error: 'Skill description must contain 10–300 characters.' });
  if (instructions.length < 20 || instructions.length > 12000) return res.status(400).json({ error: 'Skill instructions must contain 20–12,000 characters.' });
  const slug = skillSlugFromName(name);
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return res.status(400).json({ error: 'Use an English name with letters or numbers so OpenCode can create a valid skill ID.' });
  const user = selectUserById.get(req.authUser.id);
  const existing = instances.get(user.id);
  if (existing && existing.ready && existing.busy) return res.status(409).json({ error: 'Wait for the current coding task to finish before changing skills.' });
  let instance;
  try {
    instance = await ensureOpenCodeForUser(user);
    if (instance.ready && instance.busy) return res.status(409).json({ error: 'Wait for the current coding task to finish before changing skills.' });
    const root = resolveUserSkillRoot(instance.homeDir, true, instance.uid, instance.gid);
    const currentSkills = readCustomSkills(instance.homeDir);
    if (currentSkills.length >= 20) return res.status(409).json({ error: 'You can save up to 20 custom skills.' });
    const id = `custom-${slug}`;
    const directory = path.join(root, id);
    try { fs.lstatSync(directory); return res.status(409).json({ error: 'A skill with a similar name already exists.' }); }
    catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chownSync(directory, instance.uid, instance.gid); fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'SKILL.md');
    const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  version: "1"\n---\n\n${instructions}\n`;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, content, 'utf8'); } finally { fs.closeSync(fd); }
    fs.chownSync(file, instance.uid, instance.gid); fs.chmodSync(file, 0o600);
    // A running OpenCode server may have cached its skill catalog; restart the
    // user's isolated worker so the newly added skill is loaded on next use.
    stopInstance(user.id);
    res.status(201).json({ ok: true, skill: { id, name, description }, message: 'Skill saved. OpenCode will reload your personal skills for the next task.' });
  } catch (err) {
    console.error(`Unable to create skill for user ${user.id}: ${String(err.message || err)}`);
    res.status(500).json({ error: 'Could not save the skill. Please try again.' });
  }
});
app.delete('/api/user/skills/:id', requireAuth, requireSubscription, skillChangeLimiter, (req, res) => {
  const id = String(req.params.id || '');
  if (!/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return res.status(400).json({ error: 'Only your own custom skills can be removed.' });
  const current = instances.get(req.authUser.id);
  if (current && current.ready && current.busy) return res.status(409).json({ error: 'Wait for the current coding task to finish before changing skills.' });
  const homeDir = path.join(HOMES_DIR, String(req.authUser.id));
  try {
    const root = resolveUserSkillRoot(homeDir, false);
    if (!root) return res.status(404).json({ error: 'Skill not found.' });
    const directory = path.join(root, id);
    let stat;
    try { stat = fs.lstatSync(directory); } catch (err) { if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'Skill not found.' }); throw err; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return res.status(400).json({ error: 'Invalid skill directory.' });
    const skillFile = path.join(directory, 'SKILL.md');
    try { if (fs.lstatSync(skillFile).isSymbolicLink()) return res.status(400).json({ error: 'Invalid skill file.' }); } catch (err) { if (err && err.code !== 'ENOENT') throw err; }
    fs.rmSync(directory, { recursive: true, force: false });
    stopInstance(req.authUser.id);
    res.json({ ok: true, id, message: 'Skill removed. OpenCode will reload your skills for the next task.' });
  } catch (err) {
    console.error(`Unable to delete skill for user ${req.authUser.id}: ${String(err.message || err)}`);
    res.status(500).json({ error: 'Could not remove the skill.' });
  }
});

app.get('/api/chat/history', requireAuth, requireSubscription, (req, res) => {
  const rows = selectMessages.all(req.authUser.id, 80).reverse().map(row => {
    let metadata = null;
    if (row.metadata_json) { try { metadata = JSON.parse(row.metadata_json); } catch {} }
    return { role: row.role, content: row.content, created_at: row.created_at, metadata };
  });
  res.json({ messages: rows });
});
app.post('/api/chat/warmup', requireAuth, requireSubscription, (req, res) => {
  const user = selectUserById.get(req.authUser.id);
  if (!aiConfigReady(user)) return res.status(503).json({ error: 'AI connection is not configured for this account.' });
  // Start OpenCode in the background while the user is viewing the workspace,
  // rather than charging its cold-start time to the first chat response.
  ensureOpenCodeForUser(user).catch(err => {
    console.warn(`OpenCode warm-up did not complete for user ${user.id}: ${String(err.message || err)}`);
  });
  res.status(202).json({ ok: true, status: 'warming' });
});

app.post('/api/chat', requireAuth, requireSubscription, chatLimiter, async (req, res) => {
  const requestStartedAt = Date.now();
  const prompt = String(req.body && req.body.message || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Enter a task before sending.' });
  if (prompt.length > 30_000) return res.status(413).json({ error: 'Your message is too long. Keep it under 30,000 characters.' });
  const userNow = selectUserById.get(req.authUser.id);
  if (!aiConfigReady(userNow)) return res.status(503).json({ error: 'The coding assistant is not configured for this account yet. Please contact the administrator.' });
  try {
    if (!isActiveSubscription(userNow)) return res.status(402).json({ error: 'Your subscription has expired or needs renewal.' });
    const instance = await ensureOpenCodeForUser(userNow);
    instance.busy = true;
    if (!userNow.opencode_session_id) {
      const create = await openCodeFetch(instance, '/session', { method: 'POST', body: JSON.stringify({ title: prompt.slice(0, 90) }) });
      if (!create.ok) throw new Error(`OpenCode session creation failed (${create.status})`);
      const session = await create.json();
      db.prepare('UPDATE users SET opencode_session_id = ? WHERE id = ?').run(session.id, userNow.id);
      userNow.opencode_session_id = session.id;
    }
    const url = `/session/${encodeURIComponent(userNow.opencode_session_id)}/message`;
    const response = await openCodeFetch(instance, url, {
      method: 'POST',
      body: JSON.stringify({ agent: 'build', parts: [{ type: 'text', text: prompt }] }),
      signal: AbortSignal.timeout(Number(process.env.AI_TASK_TIMEOUT_MS || 600_000))
    });
    if (!response.ok) {
      const internal = await response.text().catch(() => '');
      console.error(`OpenCode request failed for user ${userNow.id} (${response.status}): ${internal.slice(0, 1500)}`);
      throw new Error(`OpenCode request failed (${response.status})`);
    }
    const payload = await response.json();
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    const answer = parts.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n\n').trim();
    const finalText = answer || 'The task finished without a text response. Check the workspace files or try a more specific prompt.';
    const toolsUsed = [...new Set(parts.filter(part => part && (part.type === 'tool' || part.type === 'tool-invocation') && typeof (part.tool || part.name) === 'string').map(part => part.tool || part.name))].slice(0, 40);
    const durationMs = Date.now() - requestStartedAt;
    const tokenUsage = summarizeTokenUsage(payload.info || payload.message && payload.message.info || {});
    const metadata = { durationMs, tokenUsage };
    insertMessage.run(userNow.id, 'user', prompt, null);
    insertMessage.run(userNow.id, 'assistant', finalText, JSON.stringify(metadata));
    res.json({ answer: finalText, toolsUsed, sessionId: userNow.opencode_session_id, durationMs, tokenUsage });
  } catch (err) {
    console.error(`Coding request failed for user ${req.authUser.id}:`, err && err.message ? err.message : 'unknown error');
    res.status(502).json({ error: 'The task could not be completed. The coding service may be busy; please try again shortly.' });
  } finally {
    const instance = instances.get(req.authUser.id);
    if (instance) { instance.busy = false; instance.lastUsedAt = Date.now(); }
  }
});
app.post('/api/chat/new', requireAuth, requireSubscription, (req, res) => {
  db.prepare('UPDATE users SET opencode_session_id = NULL WHERE id = ?').run(req.authUser.id);
  res.json({ ok: true });
});

const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 30, fields: 2, fieldSize: 40 * 1024 } }).array('files', 30);
app.post('/api/workspace/upload', requireAuth, requireSubscription, (req, res, next) => {
  uploadMiddleware(req, res, err => { if (err) return res.status(400).json({ error: 'Unable to upload files. The limit is 30 files, up to 5 MB each.' }); next(); });
}, async (req, res) => {
  try {
    const user = selectUserById.get(req.authUser.id);
    if (!aiConfigReady(user)) return res.status(503).json({ error: 'The coding assistant is not configured for this account yet. Please contact the administrator.' });
    const instance = await ensureOpenCodeForUser(user);
    const inputPaths = JSON.parse(String(req.body && req.body.paths || '[]'));
    if (!Array.isArray(inputPaths) || inputPaths.length !== (req.files || []).length) return res.status(400).json({ error: 'Invalid file list.' });
    const entries = [];
    for (let i = 0; i < req.files.length; i++) {
      let relative = String(inputPaths[i] || req.files[i].originalname || '').replace(/\\/g, '/');
      relative = relative.replace(/^\.\//, '');
      const parts = relative.split('/');
      if (!relative || relative.startsWith('/') || parts.some(part => !part || part === '.' || part === '..') || relative.length > 240) return res.status(400).json({ error: 'One of the file paths is invalid.' });
      if (parts.some(part => part === '.git' || part === 'node_modules' || part === '.venv' || part === 'venv')) continue;
      if (/(^|\/)\.env($|\.)/i.test(relative) || /(^|\/)(id_rsa|id_ed25519|credentials[^/]*\.json)$/i.test(relative) || /\.(pem|key|p12|pfx)$/i.test(relative)) continue;
      entries.push({ relative, file: req.files[i] });
    }
    for (const entry of entries) {
      const destination = path.resolve(instance.workspace, entry.relative);
      if (!destination.startsWith(instance.workspace + path.sep)) return res.status(400).json({ error: 'One of the file paths is not allowed.' });
      const relativeParent = path.posix.dirname(entry.relative);
      let current = instance.workspace;
      if (relativeParent !== '.') {
        for (const segment of relativeParent.split('/')) {
          current = path.join(current, segment);
          try {
            const st = fs.lstatSync(current);
            if (st.isSymbolicLink() || !st.isDirectory()) return res.status(400).json({ error: 'File paths containing symbolic links are not allowed.' });
          } catch (err) {
            if (err && err.code !== 'ENOENT') throw err;
            fs.mkdirSync(current, { mode: 0o700 });
            fs.chownSync(current, instance.uid, instance.gid);
            fs.chmodSync(current, 0o700);
          }
        }
      }
      try {
        const targetStat = fs.lstatSync(destination);
        if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1) return res.status(400).json({ error: 'Replacing unusual files or symbolic links is not allowed.' });
      } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(destination, flags, 0o600);
      try { fs.writeFileSync(fd, entry.file.buffer); } finally { fs.closeSync(fd); }
      fs.chownSync(destination, instance.uid, instance.gid);
      fs.chmodSync(destination, 0o600);
    }
    res.json({ uploaded: entries.length, skipped: req.files.length - entries.length, message: `Uploaded ${entries.length} file(s) to your workspace.` });
  } catch (err) {
    console.error(`Workspace upload failed for user ${req.authUser.id}:`, err.message);
    res.status(500).json({ error: 'Unable to save files to the workspace.' });
  }
});

app.get('/api/workspace/export', requireAuth, requireSubscription, (req, res) => {
  const workspace = path.join(WORKSPACES_DIR, String(req.authUser.id));
  if (!fs.existsSync(workspace)) return res.status(404).json({ error: 'There are no project files to download yet.' });
  const exportsDir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  const zipPath = path.join(exportsDir, `project-${req.authUser.id}-${crypto.randomBytes(6).toString('hex')}.zip`);
  const py = String.raw`import os, sys, zipfile
root, target = sys.argv[1], sys.argv[2]
skip_dirs = {'.git', 'node_modules', '.venv', 'venv', '__pycache__'}
def safe_file(rel):
    parts = rel.replace('\\', '/').split('/')
    name = parts[-1].lower()
    if any(p in skip_dirs for p in parts): return False
    if name == '.env' or name.startswith('.env.'): return False
    if name in ('id_rsa','id_ed25519') or name.endswith(('.pem','.key','.p12','.pfx')): return False
    if name.startswith('credentials') and name.endswith('.json'): return False
    return True
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not os.path.islink(os.path.join(base,d))]
        for filename in files:
            full = os.path.join(base, filename)
            if os.path.islink(full): continue
            rel = os.path.relpath(full, root)
            if safe_file(rel): z.write(full, rel)
`;
  const out = spawnSync('python3', ['-c', py, workspace, zipPath], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (out.status !== 0) { console.error('Project export failed:', String(out.stderr || '').slice(0, 500)); return res.status(500).json({ error: 'Unable to prepare the project archive for download.' }); }
  res.download(zipPath, `codecraft-project-${req.authUser.id}.zip`, err => { try { fs.unlinkSync(zipPath); } catch {} if (err && !res.headersSent) res.status(500).end(); });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request size exceeds the allowed limit.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request format.' });
  console.error('Request failed:', err && err.message ? err.message : 'unknown error');
  return res.status(500).json({ error: 'An internal error occurred. Please try again.' });
});

const appServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`CodeCraft web service listening on port ${PORT}`);
  if (!aiConfigReady()) console.warn('No default AI API configured. Assign a user-specific API from /admin before testing the coding workspace.');
  console.log('Subscription approvals are handled manually in /admin.');
});
proxyServer.listen(AI_PROXY_PORT, AI_PROXY_HOST, () => console.log('Internal AI gateway listening on loopback.'));

function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping coding workers.`);
  for (const userId of [...instances.keys()]) stopInstance(userId);
  proxyServer.close();
  appServer.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 6_000).unref();
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('unhandledRejection', err => console.error('Unhandled background error:', err && err.message ? err.message : 'unknown error'));
