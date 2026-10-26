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
const { applyGenerationControls, ALLOWED_REASONING_LEVELS, getOpenCodeModelCapabilities, isGemini25ProModel } = require('./generation-controls');
const { configurePostgresTls } = require('./database-tls');

const CODECRAFT_RELEASE_ID = 'odirouter-opencode-proxy-scopefix-20261026-r7';
console.info(`CODECRAFT_RELEASE_ID=${CODECRAFT_RELEASE_ID}`);

process.umask(0o077);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Express 4 does not automatically forward rejected async route promises.
// Wrap route handlers so a transient Supabase outage returns through the
// normal error handler instead of leaving the request hanging.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = function registerRouteWithAsyncErrors(route, ...handlers) {
    if (typeof route !== 'string' && !(route instanceof RegExp)) return original(route, ...handlers);
    const wrapped = handlers.map(handler => {
      if (typeof handler !== 'function' || handler.length === 4) return handler;
      return function asyncErrorBoundary(req, res, next) {
        try {
          const result = handler(req, res, next);
          if (result && typeof result.then === 'function') result.catch(next);
          return result;
        } catch (err) { return next(err); }
      };
    });
    return original(route, ...wrapped);
  };
}

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
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
let pgPool = null;
let sqliteDb = null;
let databaseTlsMode = 'sqlite-local';
let databaseHost = null;
let db;

// Supabase PostgreSQL is the primary persistent store when DATABASE_URL is set.
// SQLite remains as a local-development fallback and as a one-time migration source.
if (DATABASE_URL) {
  try { databaseHost = new URL(DATABASE_URL).hostname; } catch { databaseHost = null; }
  databaseTlsMode = String(process.env.SUPABASE_TLS_MODE || 'verify').trim().toLowerCase();
  const { Pool, types } = require('pg');
  // PostgreSQL int8 columns used by this app stay safely within JavaScript's
  // integer range; parsing them as numbers avoids string/number ID mismatches.
  types.setTypeParser(20, value => Number(value));
  const postgresTls = configurePostgresTls(DATABASE_URL);
  databaseTlsMode = postgresTls.mode;
  databaseHost = new URL(DATABASE_URL).hostname;
  const poolOptions = {
    connectionString: postgresTls.connectionString,
    max: Math.max(2, Math.min(10, Number(process.env.DB_POOL_MAX || 5))),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 12_000
  };
  // In compatibility mode the helper explicitly sets ssl.rejectUnauthorized=false.
  // TLS encryption remains enabled, but server identity is not verified; use only
  // as a temporary diagnostic on Supabase. Verified CA mode is the default.
  if (postgresTls.ssl) poolOptions.ssl = postgresTls.ssl;
  pgPool = new Pool(poolOptions);
  pgPool.on('error', err => {
    console.error('PostgreSQL pool error:', JSON.stringify({
      code: err && err.code || null,
      message: err && err.message || 'unknown database connection error',
      tlsMode: databaseTlsMode,
      host: databaseHost
    }));
  });
  console.info(`PostgreSQL TLS mode: ${postgresTls.mode}; host: ${databaseHost}`);
  function pgSql(sql) {
    let index = 0;
    return String(sql).replace(/\?/g, () => `$${++index}`);
  }
  db = {
    isPostgres: true,
    prepare(sql) {
      const text = pgSql(sql);
      return {
        get: async (...params) => (await pgPool.query(text, params)).rows[0],
        all: async (...params) => (await pgPool.query(text, params)).rows,
        run: async (...params) => {
          const result = await pgPool.query(text, params);
          return { changes: result.rowCount, rows: result.rows };
        }
      };
    },
    exec: async sql => pgPool.query(sql),
    close: async () => pgPool.end()
  };
} else {
  sqliteDb = new Database(DB_PATH);
  try { fs.chmodSync(DB_PATH, 0o600); } catch {}
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  db = {
    isPostgres: false,
    prepare: sql => sqliteDb.prepare(sql),
    exec: sql => sqliteDb.exec(sql),
    pragma: sql => sqliteDb.pragma(sql),
    close: () => sqliteDb.close()
  };
  if (process.env.NODE_ENV === 'production') {
    console.warn('DATABASE_URL is not configured; using the local SQLite database. Configure Supabase on Render for remote persistence.');
  }
}

console.info('CodeCraft runtime identity:', JSON.stringify({
  release: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown',
  renderServiceId: process.env.RENDER_SERVICE_ID || null,
  nodeVersion: process.version,
  databaseConfigured: Boolean(DATABASE_URL),
  databaseHost,
  databaseTlsMode,
  databaseTlsModeSetting: DATABASE_URL ? String(process.env.SUPABASE_TLS_MODE || 'verify').trim().toLowerCase() : 'not-applicable'
}));

const selectUserById = { get: (...params) => db.prepare('SELECT * FROM users WHERE id = ?').get(...params) };
const selectUserByEmail = { get: (...params) => db.prepare('SELECT * FROM users WHERE email = ?').get(...params) };
const insertMessage = { run: (...params) => db.prepare('INSERT INTO chat_messages (user_id, role, content, metadata_json) VALUES (?, ?, ?, ?)').run(...params) };
const selectMessages = { all: (...params) => db.prepare('SELECT role, content, created_at, metadata_json FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(...params) };

const defaultSystemPrompt = fs.readFileSync(DEFAULT_SYSTEM_PROMPT_PATH, 'utf8').trim();
const LEGACY_DEFAULT_SYSTEM_PROMPT_SHA256 = '23ed594eadbeb98e081567d90dd72ae8fa5d5e6fed0de274a6f87d4aa127498d';
async function getAppSetting(key) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
async function setAppSetting(key, value) {
  await db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, String(value));
}
async function syncRuntimeSystemPrompt() {
  const value = String(await getAppSetting('system_prompt') || defaultSystemPrompt).trim();
  fs.writeFileSync(SYSTEM_PROMPT_PATH, `${value}\n`, { encoding: 'utf8', mode: 0o644 });
  fs.chmodSync(SYSTEM_PROMPT_PATH, 0o644);
}

const DB_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    subscription_status TEXT NOT NULL DEFAULT 'inactive',
    subscription_source TEXT NOT NULL DEFAULT 'manual',
    subscription_requested_at TEXT,
    subscription_current_period_end BIGINT,
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id_id ON chat_messages(user_id, id);
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

async function migrateLegacySqliteToSupabase() {
  if (!pgPool || process.env.MIGRATE_SQLITE_TO_SUPABASE === 'false' || !fs.existsSync(DB_PATH)) return;
  const marker = await db.prepare('SELECT value FROM app_settings WHERE key = ?').get('legacy_sqlite_migration');
  if (marker) return;
  const target = await db.prepare('SELECT COUNT(*)::int AS count FROM users').get();
  if (Number(target && target.count || 0) > 0) {
    console.warn('Supabase already contains users; automatic SQLite import skipped to avoid overwriting existing records.');
    await setAppSetting('legacy_sqlite_migration', 'skipped-existing-supabase-data');
    return;
  }
  let legacy;
  try {
    legacy = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const tables = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has('users')) { legacy.close(); return; }
  } catch (err) {
    try { if (legacy) legacy.close(); } catch {}
    console.warn('Legacy SQLite migration source could not be opened:', err.message);
    return;
  }
  const client = await pgPool.connect();
  try {
    const userRows = legacy.prepare('SELECT * FROM users ORDER BY id').all();
    const messageRows = tablesHas(legacy, 'chat_messages') ? legacy.prepare('SELECT * FROM chat_messages ORDER BY id').all() : [];
    const settingRows = tablesHas(legacy, 'app_settings') ? legacy.prepare('SELECT * FROM app_settings').all() : [];
    await client.query('BEGIN');
    const userFields = ['id','email','password_hash','subscription_status','subscription_source','subscription_requested_at','subscription_current_period_end','opencode_session_id','is_admin','is_disabled','ai_base_url','ai_model_id','ai_api_key_encrypted','reasoning_level','thinking_mode','thinking_budget','output_target','created_at'];
    for (const row of userRows) {
      const fallback = { subscription_status: 'inactive', subscription_source: 'manual', is_admin: 0, is_disabled: 0, thinking_mode: 'auto', thinking_budget: 8192, output_target: 5000, created_at: new Date().toISOString() };
      const values = userFields.map(field => row[field] === undefined ? (fallback[field] === undefined ? null : fallback[field]) : row[field]);
      const slots = values.map((_, i) => `$${i + 1}`).join(',');
      await client.query(`INSERT INTO users(${userFields.join(',')}) VALUES(${slots}) ON CONFLICT (id) DO NOTHING`, values);
    }
    for (const row of messageRows) {
      const values = [row.id, row.user_id, row.role, row.content, row.created_at || new Date().toISOString(), row.metadata_json || null];
      await client.query('INSERT INTO chat_messages(id,user_id,role,content,created_at,metadata_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', values);
    }
    for (const row of settingRows) {
      await client.query('INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING', [row.key, row.value, row.updated_at || new Date().toISOString()]);
    }
    await client.query("INSERT INTO app_settings(key,value,updated_at) VALUES('legacy_sqlite_migration','completed',CURRENT_TIMESTAMP) ON CONFLICT(key) DO NOTHING");
    await client.query("SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users), 1), EXISTS(SELECT 1 FROM users))");
    await client.query("SELECT setval(pg_get_serial_sequence('chat_messages','id'), COALESCE((SELECT MAX(id) FROM chat_messages), 1), EXISTS(SELECT 1 FROM chat_messages))");
    await client.query('COMMIT');
    console.info(`Imported legacy SQLite data into Supabase: ${userRows.length} users, ${messageRows.length} chat messages, ${settingRows.length} settings.`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
    try { legacy.close(); } catch {}
  }
}
function tablesHas(legacy, table) {
  return !!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

async function initializeDatabase() {
  if (db.isPostgres) {
    await db.exec(DB_SCHEMA_SQL);
    await db.exec(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_requested_at TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reasoning_level TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS thinking_mode TEXT NOT NULL DEFAULT 'auto';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS thinking_budget INTEGER NOT NULL DEFAULT 8192;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS output_target INTEGER NOT NULL DEFAULT 5000;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata_json TEXT;
    `);
    await migrateLegacySqliteToSupabase();
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        subscription_status TEXT NOT NULL DEFAULT 'inactive', subscription_source TEXT NOT NULL DEFAULT 'manual',
        subscription_requested_at TEXT, subscription_current_period_end INTEGER, opencode_session_id TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0, is_disabled INTEGER NOT NULL DEFAULT 0,
        ai_base_url TEXT, ai_model_id TEXT, ai_api_key_encrypted TEXT, reasoning_level TEXT,
        thinking_mode TEXT NOT NULL DEFAULT 'auto', thinking_budget INTEGER NOT NULL DEFAULT 8192,
        output_target INTEGER NOT NULL DEFAULT 5000, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id_id ON chat_messages(user_id, id);
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    const userColumns = new Set(db.pragma('table_info(users)').map(column => column.name));
    for (const [name, definition] of Object.entries({
      is_admin: 'INTEGER NOT NULL DEFAULT 0', is_disabled: 'INTEGER NOT NULL DEFAULT 0',
      ai_base_url: 'TEXT', ai_model_id: 'TEXT', ai_api_key_encrypted: 'TEXT', reasoning_level: 'TEXT',
      thinking_mode: "TEXT NOT NULL DEFAULT 'auto'", thinking_budget: 'INTEGER NOT NULL DEFAULT 8192',
      output_target: 'INTEGER NOT NULL DEFAULT 5000', subscription_source: "TEXT NOT NULL DEFAULT 'manual'",
      subscription_requested_at: 'TEXT'
    })) if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    const chatColumns = new Set(db.pragma('table_info(chat_messages)').map(column => column.name));
    if (!chatColumns.has('metadata_json')) db.exec('ALTER TABLE chat_messages ADD COLUMN metadata_json TEXT');
  }
  const savedPrompt = await getAppSetting('system_prompt');
  if (savedPrompt === null) await setAppSetting('system_prompt', defaultSystemPrompt);
  else {
    const savedPromptHash = crypto.createHash('sha256').update(String(savedPrompt).trim(), 'utf8').digest('hex');
    if (savedPromptHash === LEGACY_DEFAULT_SYSTEM_PROMPT_SHA256) await setAppSetting('system_prompt', defaultSystemPrompt);
  }
  await syncRuntimeSystemPrompt();
}


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
const sessionStartPromises = new Map();
let lastGenerationDiagnostic = null;
let lastOpenCodeTaskDiagnostic = null;
let lastOpenCodeWorkerConfigDiagnostic = null;
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

function redactProviderDiagnostic(value, apiKey = '') {
  let text = String(value || 'Unknown provider error');
  if (apiKey) text = text.split(apiKey).join('[redacted-key]');
  return text
    .replace(/Bearer\s+[^\s,;]+/ig, 'Bearer [redacted]')
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '[redacted-key]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 360);
}

function providerJsonRequest(config, payload, timeoutMs = 20_000) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let target;
    try { target = getProviderTarget('/v1/chat/completions', config); }
    catch (err) {
      return resolve({ ok: false, statusCode: null, latencyMs: Date.now() - startedAt,
        errorCode: err && err.code || 'INVALID_PROVIDER_URL', errorMessage: redactProviderDiagnostic(err && err.message, config && config.apiKey) });
    }
    const body = Buffer.from(JSON.stringify(payload));
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, { method: 'POST', timeout: timeoutMs, headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      'content-length': String(body.length),
      'accept-encoding': 'identity'
    } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (bytes < 64 * 1024) {
          const safeChunk = chunk.subarray(0, 64 * 1024 - bytes);
          chunks.push(safeChunk); bytes += safeChunk.length;
        }
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        const statusCode = Number(response.statusCode || 502);
        const error = data && data.error;
        const errorCode = error && typeof error.code === 'string' ? error.code.slice(0, 100) : null;
        const errorMessage = statusCode >= 400
          ? redactProviderDiagnostic(error && (error.message || error) || raw || `Provider returned HTTP ${statusCode}.`, config.apiKey)
          : null;
        resolve({ ok: statusCode >= 200 && statusCode < 300, statusCode,
          latencyMs: Date.now() - startedAt, data, errorCode, errorMessage,
          host: target.host });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Provider request timed out.'), { code: 'ETIMEDOUT' })));
    request.on('error', err => resolve({ ok: false, statusCode: null, latencyMs: Date.now() - startedAt,
      errorCode: err && err.code || 'PROVIDER_TRANSPORT_ERROR',
      errorMessage: redactProviderDiagnostic(err && err.message, config.apiKey), host: target.host }));
    request.end(body);
  });
}

function providerTextFromResponse(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(part => part && typeof part.text === 'string' ? part.text : '').join(' ').trim();
  return '';
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
    const user = await selectUserById.get(userId);
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
    req.on('end', async () => {
      let body = Buffer.concat(chunks);
      let generationDiagnosticId = null;
      try {
      if (requestPath === '/v1/chat/completions') {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          const activeSystemPrompt = String((await getAppSetting('system_prompt')) || defaultSystemPrompt).trim();
          const transformed = applyGenerationControls(parsed, user, aiConfig, activeSystemPrompt);
          body = Buffer.from(JSON.stringify(transformed.body));
          // Operational proof without logging prompts or credentials. This makes
          // it possible to diagnose whether the stored settings reached the gateway.
          generationDiagnosticId = crypto.randomUUID();
          lastGenerationDiagnostic = {
            id: generationDiagnosticId,
            at: new Date().toISOString(),
            userId,
            modelFamily: transformed.diagnostics.modelFamily,
            modelId: transformed.diagnostics.modelId,
            upstreamHost: target.host,
            thinkingEnabled: transformed.diagnostics.thinkingEnabled,
            reasoningLevel: transformed.diagnostics.reasoningLevel,
            thinkingBudget: transformed.diagnostics.thinkingBudget,
            reasoningParameter: transformed.diagnostics.reasoningParameter,
            maxOutputTokens: transformed.diagnostics.maxOutputTokens,
            toolDefinitions: transformed.diagnostics.toolDefinitions,
            toolNames: transformed.diagnostics.toolNames,
            toolChoice: transformed.diagnostics.toolChoice,
            upstreamStatusCode: null,
            upstreamSucceeded: null,
            systemPromptIncluded: transformed.diagnostics.systemPromptIncluded,
            systemPromptInjected: transformed.diagnostics.systemPromptInjected
          };
          console.info('Generation controls applied:', JSON.stringify(lastGenerationDiagnostic));
        } catch (err) {
          console.warn('Could not prepare OpenAI-compatible request:', String(err && err.message || err));
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"error":"invalid_request_or_generation_settings"}');
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
        if (generationDiagnosticId && lastGenerationDiagnostic && lastGenerationDiagnostic.id === generationDiagnosticId) {
          lastGenerationDiagnostic.upstreamStatusCode = upstreamRes.statusCode || 500;
          lastGenerationDiagnostic.upstreamSucceeded = (upstreamRes.statusCode || 500) < 400;
          lastGenerationDiagnostic.upstreamRespondedAt = new Date().toISOString();
        }
        if ((upstreamRes.statusCode || 500) >= 400) {
          const errorChunks = [];
          let errorBytes = 0;
          upstreamRes.on('data', chunk => {
            if (errorBytes >= 4096) return;
            const limited = chunk.subarray(0, 4096 - errorBytes);
            errorChunks.push(limited);
            errorBytes += limited.length;
          });
          upstreamRes.on('end', () => {
            let providerErrorCode = null;
            let providerErrorMessage = 'Provider returned an HTTP error.';
            try {
              const upstreamBody = JSON.parse(Buffer.concat(errorChunks).toString('utf8'));
              const detail = upstreamBody && upstreamBody.error;
              providerErrorCode = detail && typeof detail.code === 'string' ? detail.code.slice(0, 100) : null;
              if (detail && typeof detail.message === 'string') providerErrorMessage = detail.message;
              else if (typeof detail === 'string') providerErrorMessage = detail;
            } catch {}
            providerErrorMessage = String(providerErrorMessage)
              .replace(/Bearer\s+[^\s,;]+/ig, 'Bearer [redacted]')
              .replace(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '[redacted-key]')
              .replace(/[\r\n\t]+/g, ' ').slice(0, 400);
            if (generationDiagnosticId && lastGenerationDiagnostic && lastGenerationDiagnostic.id === generationDiagnosticId) {
              lastGenerationDiagnostic.upstreamErrorCode = providerErrorCode;
              lastGenerationDiagnostic.upstreamErrorMessage = providerErrorMessage;
            }
            res.writeHead(upstreamRes.statusCode || 502, {
              'content-type': 'application/json',
              ...(upstreamRes.headers['retry-after'] ? { 'retry-after': upstreamRes.headers['retry-after'] } : {})
            });
            res.end(JSON.stringify({ error: { message: 'The coding service could not complete this request.', type: 'service_error' } }));
          });
          return;
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
      upstreamReq.on('error', err => {
        if (generationDiagnosticId && lastGenerationDiagnostic && lastGenerationDiagnostic.id === generationDiagnosticId) {
          lastGenerationDiagnostic.upstreamTransportError = { code: err && err.code || null, message: String(err && err.message || 'upstream transport error').slice(0, 240) };
        }
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end('{"error":"provider_unavailable"}');
      });
      upstreamReq.end(body);
      } catch (err) {
        const safeMessage = String(err && err.message || 'internal gateway error')
          .replace(/Bearer\s+[^\s,;]+/ig, 'Bearer [redacted]')
          .replace(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '[redacted-key]')
          .replace(/[\r\n\t]+/g, ' ').slice(0, 240);
        if (generationDiagnosticId && lastGenerationDiagnostic && lastGenerationDiagnostic.id === generationDiagnosticId) {
          lastGenerationDiagnostic.gatewayError = safeMessage;
        }
        console.error('AI gateway request preparation failed:', JSON.stringify({ code: err && err.code || null, message: safeMessage }));
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end('{"error":"provider_request_preparation_failed"}');
      }
    });
  })().catch(err => {
    const safeMessage = String(err && err.message || 'internal gateway error')
      .replace(/Bearer\s+[^\s,;]+/ig, 'Bearer [redacted]')
      .replace(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '[redacted-key]')
      .replace(/[\r\n\t]+/g, ' ').slice(0, 240);
    console.error('AI gateway request failed before forwarding:', JSON.stringify({ code: err && err.code || null, message: safeMessage }));
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

async function ensureOpenCodeSessionForUser(user, instance, title = 'CodeCraft workspace') {
  const existingId = String(user && user.opencode_session_id || '').trim();
  if (existingId) return existingId;
  const inFlight = sessionStartPromises.get(user.id);
  if (inFlight) return inFlight;
  const promise = (async () => {
    const freshUser = await selectUserById.get(user.id);
    if (freshUser && freshUser.opencode_session_id) return freshUser.opencode_session_id;
    const created = await openCodeFetch(instance, '/session', {
      method: 'POST',
      body: JSON.stringify({ title: String(title || 'CodeCraft workspace').slice(0, 90) })
    });
    if (!created.ok) throw new Error(`OpenCode session creation failed (${created.status})`);
    const session = await created.json();
    if (!session || typeof session.id !== 'string' || !session.id) throw new Error('OpenCode returned an invalid session response');
    await db.prepare('UPDATE users SET opencode_session_id = ? WHERE id = ?').run(session.id, user.id);
    return session.id;
  })();
  sessionStartPromises.set(user.id, promise);
  try { return await promise; }
  finally { if (sessionStartPromises.get(user.id) === promise) sessionStartPromises.delete(user.id); }
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
  const runtimeSystemPrompt = String(fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8')).trim();
  const workerAIConfig = getAIConfigForUser(user);
  const workerModelId = workerAIConfig.modelId;
  const workerModelIsGemini25Pro = isGemini25ProModel(workerModelId);
  const workerModelCapabilities = getOpenCodeModelCapabilities(workerModelId);
  // The gateway alias hides the upstream model ID from OpenCode's model catalog.
  // Explicit capability metadata is required so OpenCode config migration does not
  // silently discard tool-calling/reasoning support for this custom provider.
  const modelDefinition = { name: 'Code Assistant', ...workerModelCapabilities };
  lastOpenCodeWorkerConfigDiagnostic = {
    at: new Date().toISOString(),
    userId: user.id,
    modelFamily: workerModelIsGemini25Pro ? 'gemini-2.5-pro' : 'other-openai-compatible',
    modelId: String(workerModelId).slice(0, 120),
    toolCallCapability: workerModelCapabilities.tool_call,
    reasoningCapability: workerModelCapabilities.reasoning,
    contextLimit: workerModelCapabilities.limit.context,
    outputLimit: workerModelCapabilities.limit.output,
    configFormat: 'OpenCode-v1-pinned-1.19.4-legacy-provider'
  };
  console.info('OpenCode worker model capabilities:', JSON.stringify(lastOpenCodeWorkerConfigDiagnostic));
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
        // OPENCODE_CONFIG_CONTENT is inline JSON; do not depend on {env:...} token
        // substitution here. This is a per-worker proxy token, never the upstream key.
        options: { baseURL: `http://${AI_PROXY_HOST}:${AI_PROXY_PORT}/v1`, apiKey: proxyToken },
        models: { 'code-assistant': modelDefinition }
      } },
      model: 'managed/code-assistant',
      default_agent: 'build',
      websearch: { provider: 'exa' },
      // Keep the complete built-in toolset available. Prevent cross-workspace file tools;
      // each subscriber gets a private Unix identity and workspace.
      permission: { '*': 'allow', external_directory: 'deny' },
      agent: {
        // Pass the resolved prompt content directly; inline config does not reliably expand {file:...}.
        build: { mode: 'primary', prompt: runtimeSystemPrompt },
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
  // OpenCode config-normalization warnings may be written to stdout. Capture both
  // streams so worker-start failures include useful diagnostics instead of silence.
  child.stdout.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-6000); });
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
  let payload;
  try { payload = jwt.verify(token, SESSION_SECRET, { issuer: 'codecraft-membership' }); }
  catch { req.authUser = null; return next(); }
  Promise.resolve(selectUserById.get(Number(payload.sub)))
    .then(user => { req.authUser = user || null; next(); })
    .catch(next);
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
async function bootstrapAdminAccount() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) return;
  if (!validEmail(email) || Buffer.byteLength(password, 'utf8') < 14 || Buffer.byteLength(password, 'utf8') > 72) {
    console.error('Admin bootstrap skipped: set a valid ADMIN_EMAIL and an ADMIN_PASSWORD of 14-72 bytes.');
    return;
  }
  const passwordHash = bcrypt.hashSync(password, 12);
  const existing = await selectUserByEmail.get(email);
  if (existing) await db.prepare('UPDATE users SET password_hash = ?, is_admin = 1, is_disabled = 0 WHERE id = ?').run(passwordHash, existing.id);
  else await db.prepare('INSERT INTO users(email, password_hash, is_admin) VALUES(?, ?, 1)').run(email, passwordHash);
}
app.get('/healthz', async (req, res) => {
  try { await db.prepare('SELECT 1 AS ok').get(); res.status(200).json({ ok: true, service: 'codecraft', database: db.isPostgres ? 'supabase' : 'sqlite' }); }
  catch { res.status(503).json({ ok: false, service: 'codecraft', database: 'unavailable' }); }
});
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
app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    systemPrompt: (await getAppSetting('system_prompt')) || defaultSystemPrompt,
    defaultSystemPrompt
  });
});
app.patch('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const body = req.body || {};
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : null;
  if (systemPrompt !== null && (!systemPrompt || systemPrompt.length > 40000)) {
    return res.status(400).json({ error: 'System Prompt must contain 1 to 40,000 characters.' });
  }
  const previousPrompt = (await getAppSetting('system_prompt')) || defaultSystemPrompt;
  if (systemPrompt !== null) await setAppSetting('system_prompt', systemPrompt);
  try {
    if (systemPrompt !== null && systemPrompt !== previousPrompt) {
      await syncRuntimeSystemPrompt();
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
app.get('/api/admin/diagnostics', requireAuth, requireAdmin, async (req, res) => {
  const cli = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const skillsRoot = path.join(__dirname, 'opencode', 'skills');
  const bundledSkills = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot).filter(name => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return false;
    const file = path.join(skillsRoot, name, 'SKILL.md');
    try { return fs.statSync(file).isFile(); } catch { return false; }
  }).sort() : [];
  const prompt = String((await getAppSetting('system_prompt')) || defaultSystemPrompt).trim();
  let databaseReachable = false;
  try { await db.prepare('SELECT 1 AS ok').get(); databaseReachable = true; } catch {}
  res.set('Cache-Control', 'no-store');
  res.json({
    release: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown',
    database: db.isPostgres ? 'supabase' : 'sqlite',
    databaseReachable,
    databaseTlsMode,
    databaseHost,
    opencodeInstalled: cli.status === 0,
    opencodeVersion: cli.status === 0 ? String(cli.stdout || '').trim().slice(0, 100) : null,
    bundledSkills,
    activeWorkers: [...instances.values()].map(instance => ({ userId: instance.userId, ready: instance.ready, busy: instance.busy, running: instance.child.exitCode === null })),
    lastOpenCodeTaskDiagnostic,
    lastOpenCodeWorkerConfigDiagnostic,
    releaseId: CODECRAFT_RELEASE_ID,
    systemPromptConfigured: Boolean(prompt),
    systemPromptCharacters: prompt.length,
    lastGenerationDiagnostic,
    note: 'toolDefinitions/toolNames show the tool schemas sent to the model gateway; lastOpenCodeTaskDiagnostic.toolsUsed shows tools returned by OpenCode for the latest completed task. A successful upstream HTTP status confirms request acceptance, but cannot prove the provider applied every provider-specific option.'
  });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const users = (await db.prepare(`SELECT id, email, is_admin, is_disabled, subscription_status, subscription_source,
    subscription_requested_at, subscription_current_period_end, ai_base_url, ai_model_id, ai_api_key_encrypted, created_at
    FROM users ORDER BY id DESC LIMIT 500`).all()).map(user => ({
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
app.post('/api/admin/users/:id/test-ai', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
  const user = await selectUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  let config;
  try { config = getAIConfigForUser(user); } catch (err) {
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: false, phase: 'configuration', errorCode: 'CREDENTIAL_DECRYPTION_FAILED',
      message: 'The saved API credential could not be decrypted. Check that APP_ENCRYPTION_KEY is unchanged from when this key was saved.' });
  }
  if (!config || !config.baseUrl || !config.modelId || !config.apiKey) {
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: false, phase: 'configuration', errorCode: 'AI_CONFIG_MISSING', message: 'This user has no complete API configuration. Save the API URL, model ID, and API key first.' });
  }

  // Test a real text completion while sending the same reasoning controls as
  // normal workspace requests. A separate forced function call verifies that
  // the provider route returns a tool-call payload instead of trusting metadata.
  // Both requests consume some of the user's provider quota.
  const thinkingProbe = applyGenerationControls({
    model: config.modelId,
    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    max_tokens: 1024,
    stream: false
  }, user, config, '');
  // Cap this diagnostic only; applyGenerationControls otherwise uses Gemini's
  // production output ceiling, which is unnecessary for a connection probe.
  thinkingProbe.body.max_tokens = 1024;
  delete thinkingProbe.body.max_completion_tokens;
  const connection = await providerJsonRequest(config, thinkingProbe.body);
  const text = connection.data ? providerTextFromResponse(connection.data) : '';
  const connectionChoice = connection.data && connection.data.choices && connection.data.choices[0];
  const connectionUsage = connection.data && connection.data.usage;
  const reasonTokens = connectionUsage ? (
    (connectionUsage.completion_tokens_details && connectionUsage.completion_tokens_details.reasoning_tokens)
      ?? connectionUsage.reasoning_tokens
      ?? (connectionUsage.completion_tokens_details && connectionUsage.completion_tokens_details.thought_tokens)
  ) : null;
  if (!connection.ok) {
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: false, phase: 'connection', modelId: config.modelId,
      connection: { ok: false, statusCode: connection.statusCode, latencyMs: connection.latencyMs,
        errorCode: connection.errorCode || null, errorMessage: connection.errorMessage || 'Provider request failed.', host: connection.host || null },
      toolCall: { tested: false, ok: false },
      thinkingProbe: { modelFamily: thinkingProbe.diagnostics.modelFamily, enabled: thinkingProbe.diagnostics.thinkingEnabled, level: thinkingProbe.diagnostics.reasoningLevel, parameter: thinkingProbe.diagnostics.reasoningParameter, budgetSent: thinkingProbe.diagnostics.thinkingBudget },
      message: 'The OpenAI-compatible text request failed. Use the HTTP status and provider message to correct the route, key, or model ID.' });
  }
  const toolTest = await providerJsonRequest(config, {
    model: config.modelId,
    messages: [{ role: 'user', content: 'Call codecraft_diagnostic with value set to "ok". Do not reply with normal text.' }],
    tools: [{ type: 'function', function: {
      name: 'codecraft_diagnostic', description: 'Return a diagnostic value to verify function calling.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }
    } }],
    tool_choice: { type: 'function', function: { name: 'codecraft_diagnostic' } },
    // Give the routed reasoning model enough room to return the forced tool call.
    max_tokens: 2048,
    stream: false
  });
  const choice = toolTest.data && toolTest.data.choices && toolTest.data.choices[0];
  const toolCalls = choice && choice.message && Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  const toolCallOk = Boolean(toolTest.ok && toolCalls.some(call => call && call.type === 'function' && call.function && call.function.name === 'codecraft_diagnostic'));
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    modelId: config.modelId,
    source: config.source,
    connection: { ok: true, statusCode: connection.statusCode, latencyMs: connection.latencyMs, textReceived: Boolean(text), finishReason: connectionChoice && connectionChoice.finish_reason || null, reasoningTokensReported: Number.isFinite(Number(reasonTokens)) ? Number(reasonTokens) : null, host: connection.host || null },
    thinkingProbe: { modelFamily: thinkingProbe.diagnostics.modelFamily, enabled: thinkingProbe.diagnostics.thinkingEnabled, level: thinkingProbe.diagnostics.reasoningLevel, parameter: thinkingProbe.diagnostics.reasoningParameter, budgetSent: thinkingProbe.diagnostics.thinkingBudget },
    toolCall: { tested: true, ok: toolCallOk, statusCode: toolTest.statusCode,
      latencyMs: toolTest.latencyMs, errorCode: toolTest.errorCode || null,
      errorMessage: toolTest.errorMessage || null, toolNameReturned: toolCallOk ? 'codecraft_diagnostic' : null },
    thinkingSettings: userPreferencePayload(user),
    message: toolCallOk
      ? (text ? 'Connection and function calling both passed. Thinking controls are attached to normal Gemini 2.5 Pro task requests.' : 'HTTP connectivity and function calling passed, but the simple text ping returned no visible text. Inspect the route response format and token finish reason.')
      : 'HTTP connection passed, but the forced function-call check did not return the requested tool. Confirm this ODiRouter model route supports OpenAI-compatible tool calling.'
  });
});

app.post('/api/admin/users/:id/subscription', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
  const user = await selectUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const action = String((req.body && req.body.action) || '');
  if (!['activate', 'deactivate'].includes(action)) return res.status(400).json({ error: 'Invalid membership action.' });

  if (action === 'activate') {
    const rawDays = req.body && req.body.days !== undefined ? Number(req.body.days) : 30;
    if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 3650) {
      return res.status(400).json({ error: 'Membership duration must be between 1 and 3650 days.' });
    }
    const endAt = Math.floor(Date.now() / 1000) + rawDays * 86400;
    await db.prepare(`UPDATE users SET subscription_status = 'active', subscription_source = 'manual',
      subscription_current_period_end = ?, subscription_requested_at = NULL WHERE id = ?`).run(endAt, userId);
    stopInstance(userId);
    const updated = await selectUserById.get(userId);
    return res.json({ ok: true, user: { id: updated.id, email: updated.email,
      subscriptionStatus: updated.subscription_status, subscriptionActive: isActiveSubscription(updated),
      subscriptionSource: updated.subscription_source, subscriptionCurrentPeriodEnd: updated.subscription_current_period_end,
      subscriptionRequestedAt: updated.subscription_requested_at } });
  }

  await db.prepare(`UPDATE users SET subscription_status = 'inactive', subscription_source = 'manual',
    subscription_current_period_end = NULL, subscription_requested_at = NULL WHERE id = ?`).run(userId);
  stopInstance(userId);
  const updated = await selectUserById.get(userId);
  res.json({ ok: true, user: { id: updated.id, email: updated.email,
    subscriptionStatus: updated.subscription_status, subscriptionActive: isActiveSubscription(updated),
    subscriptionSource: updated.subscription_source, subscriptionCurrentPeriodEnd: updated.subscription_current_period_end,
    subscriptionRequestedAt: updated.subscription_requested_at } });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID.' });
  const user = await selectUserById.get(userId);
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
  await db.prepare('UPDATE users SET is_disabled = ?, ai_base_url = ?, ai_model_id = ?, ai_api_key_encrypted = ? WHERE id = ?')
    .run(isDisabled, baseUrl || null, modelId || null, encryptedKey, userId);
  stopInstance(userId);
  const updated = await selectUserById.get(userId);
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
  if (await selectUserByEmail.get(email)) return res.status(409).json({ error: 'This email is already registered. Please sign in instead.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    await db.prepare('INSERT INTO users(email, password_hash) VALUES(?, ?)').run(email, hash);
    // Registration intentionally does not sign the user in. The client returns
    // to the sign-in form, where the new credentials are verified explicitly.
    res.status(201).json({ created: true, message: 'Account created. Please sign in to continue.' });
  } catch (err) {
    if (['SQLITE_CONSTRAINT_UNIQUE', '23505'].includes(String(err.code))) return res.status(409).json({ error: 'This email is already registered.' });
    console.error('Registration failed:', err.message);
    res.status(500).json({ error: 'Unable to create the account right now. Please try again.' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = String(req.body && req.body.password || '');
  const user = await selectUserByEmail.get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  setSessionCookie(res, user.id);
  res.json({ user: serializeUser(user) });
});
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});

app.post('/api/billing/request-activation', requireAuth, async (req, res) => {
  const user = await selectUserById.get(req.authUser.id);
  if (isActiveSubscription(user)) return res.status(409).json({ error: 'Your subscription is already active.' });
  await db.prepare(`UPDATE users SET subscription_requested_at = COALESCE(subscription_requested_at, ?),
    subscription_source = 'manual' WHERE id = ?`).run(new Date().toISOString(), user.id);
  const updated = await selectUserById.get(user.id);
  res.status(202).json({ ok: true, subscriptionRequestedAt: updated.subscription_requested_at,
    message: 'Your activation request has been submitted. An administrator will review and activate it manually.' });
});

app.post('/api/billing/checkout', requireAuth, (req, res) => {
  res.status(410).json({ error: 'Subscription approval is handled manually in the admin panel. Request activation from the membership page.' });
});
app.post('/api/billing/portal', requireAuth, (req, res) => {
  res.status(410).json({ error: 'Subscription management is handled manually by an administrator.' });
});

function userPreferencePayload(user) {
  const requestedLevel = String(user && user.reasoning_level || 'medium').trim().toLowerCase();
  return {
    thinkingEnabled: !!(user && user.thinking_mode === 'budget'),
    reasoningLevel: ALLOWED_REASONING_LEVELS.includes(requestedLevel) ? requestedLevel : 'medium',
    reasoningLevels: ALLOWED_REASONING_LEVELS,
    note: 'When enabled, the selected thinking level is sent to the provider. When disabled, provider-default or dynamic thinking is used. Gemini 2.5 Pro cannot fully disable its internal thinking.'
  };
}
app.get('/api/user/preferences', requireAuth, requireSubscription, async (req, res) => {
  const user = await selectUserById.get(req.authUser.id);
  res.set('Cache-Control', 'no-store');
  res.json(userPreferencePayload(user));
});
app.patch('/api/user/preferences', requireAuth, requireSubscription, async (req, res) => {
  const body = req.body || {};
  const user = await selectUserById.get(req.authUser.id);
  let thinkingEnabled;
  if (body.thinkingEnabled === undefined) {
    // Backward compatibility for an older frontend that saved thinkingMode.
    thinkingEnabled = body.thinkingMode === undefined ? user && user.thinking_mode === 'budget' : body.thinkingMode === 'budget';
  } else if (typeof body.thinkingEnabled === 'boolean') thinkingEnabled = body.thinkingEnabled;
  else return res.status(400).json({ error: 'Thinking toggle must be true or false.' });

  const reasoningLevel = body.reasoningLevel === undefined
    ? (ALLOWED_REASONING_LEVELS.includes(String(user && user.reasoning_level || '').toLowerCase()) ? String(user.reasoning_level).toLowerCase() : 'medium')
    : String(body.reasoningLevel).trim().toLowerCase();
  if (!ALLOWED_REASONING_LEVELS.includes(reasoningLevel)) return res.status(400).json({ error: 'Choose Low, Medium, High, or X-High reasoning.' });
  await db.prepare('UPDATE users SET thinking_mode = ?, reasoning_level = ? WHERE id = ?')
    .run(thinkingEnabled ? 'budget' : 'auto', reasoningLevel, req.authUser.id);
  const updated = await selectUserById.get(req.authUser.id);
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
app.get('/api/user/skills', requireAuth, requireSubscription, async (req, res) => {
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
  const user = await selectUserById.get(req.authUser.id);
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

app.get('/api/chat/history', requireAuth, requireSubscription, async (req, res) => {
  const rows = (await selectMessages.all(req.authUser.id, 80)).reverse().map(row => {
    let metadata = null;
    if (row.metadata_json) { try { metadata = JSON.parse(row.metadata_json); } catch {} }
    return { role: row.role, content: row.content, created_at: row.created_at, metadata };
  });
  res.json({ messages: rows });
});
app.post('/api/chat/warmup', requireAuth, requireSubscription, async (req, res) => {
  const user = await selectUserById.get(req.authUser.id);
  if (!aiConfigReady(user)) return res.status(503).json({ error: 'AI connection is not configured for this account.' });
  // Start the isolated OpenCode worker and pre-create its session as soon as
  // the user enters the workspace. Keep this off the page-load critical path.
  ensureOpenCodeForUser(user)
    .then(instance => ensureOpenCodeSessionForUser(user, instance))
    .then(sessionId => console.info('OpenCode workspace prewarmed:', JSON.stringify({ userId: user.id, sessionReady: Boolean(sessionId) })))
    .catch(err => {
      console.warn(`OpenCode warm-up did not complete for user ${user.id}: ${String(err.message || err)}`);
    });
  res.status(202).json({ ok: true, status: 'warming' });
});

app.post('/api/chat', requireAuth, requireSubscription, chatLimiter, async (req, res) => {
  const requestStartedAt = Date.now();
  const prompt = String(req.body && req.body.message || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Enter a task before sending.' });
  if (prompt.length > 30_000) return res.status(413).json({ error: 'Your message is too long. Keep it under 30,000 characters.' });
  const userNow = await selectUserById.get(req.authUser.id);
  if (!aiConfigReady(userNow)) return res.status(503).json({ error: 'The coding assistant is not configured for this account yet. Please contact the administrator.' });
  try {
    if (!isActiveSubscription(userNow)) return res.status(402).json({ error: 'Your subscription has expired or needs renewal.' });
    const instance = await ensureOpenCodeForUser(userNow);
    instance.busy = true;
    userNow.opencode_session_id = await ensureOpenCodeSessionForUser(userNow, instance, prompt.slice(0, 90));
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
    const messagePayload = payload && payload.message && typeof payload.message === 'object' ? payload.message : payload;
    const parts = Array.isArray(payload.parts) ? payload.parts
      : Array.isArray(messagePayload.parts) ? messagePayload.parts
      : Array.isArray(payload.output && payload.output.parts) ? payload.output.parts : [];
    const answer = parts.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n\n').trim()
      || (typeof payload.output_text === 'string' ? payload.output_text.trim() : '')
      || (typeof messagePayload.content === 'string' ? messagePayload.content.trim() : '');
    const toolsUsed = [...new Set(parts.filter(part => part && (part.type === 'tool' || part.type === 'tool-invocation' || part.type === 'tool-call') && typeof (part.tool || part.name || part.toolName) === 'string').map(part => part.tool || part.name || part.toolName))].filter(name => /^[A-Za-z0-9_.:-]{1,80}$/.test(name)).slice(0, 40);
    const durationMs = Date.now() - requestStartedAt;
    const messageInfo = payload.info || messagePayload.info || {};
    const tokenUsage = summarizeTokenUsage(messageInfo);
    const resultMeta = {
      userId: userNow.id, durationMs, toolCount: toolsUsed.length, toolsUsed,
      partsCount: parts.length, partTypes: [...new Set(parts.map(part => String(part && part.type || 'unknown')))].slice(0, 12),
      finishReason: messageInfo.finish && (messageInfo.finish.reason || messageInfo.finish) || messageInfo.finishReason || null,
      hasText: Boolean(answer), tokenUsageAvailable: Boolean(tokenUsage)
    };
    if (!answer) {
      lastOpenCodeTaskDiagnostic = { at: new Date().toISOString(), outcome: 'empty-response', ...resultMeta };
      console.warn('OpenCode returned no final text:', JSON.stringify(resultMeta));
      return res.status(502).json({ error: toolsUsed.length
        ? 'OpenCode used tools but the provider did not return a final text answer. Retry with Thinking off or Low; if it repeats, check the provider response diagnostics.'
        : 'The provider returned no final text. Retry with Thinking off or Low; if this repeats, check the OdiRouter model route and response diagnostics.' });
    }
    lastOpenCodeTaskDiagnostic = { at: new Date().toISOString(), outcome: 'success', ...resultMeta };
    console.info('OpenCode task completed:', JSON.stringify(resultMeta));
    const metadata = { durationMs, tokenUsage };
    await insertMessage.run(userNow.id, 'user', prompt, null);
    await insertMessage.run(userNow.id, 'assistant', answer, JSON.stringify(metadata));
    res.json({ answer, toolsUsed, sessionId: userNow.opencode_session_id, durationMs, tokenUsage });
  } catch (err) {
    lastOpenCodeTaskDiagnostic = { at: new Date().toISOString(), userId: req.authUser.id, outcome: 'error', errorCode: err && err.code || null };
    console.error(`Coding request failed for user ${req.authUser.id}:`, err && err.message ? err.message : 'unknown error');
    res.status(502).json({ error: 'The task could not be completed. The coding service may be busy; please try again shortly.' });
  } finally {
    const instance = instances.get(req.authUser.id);
    if (instance) { instance.busy = false; instance.lastUsedAt = Date.now(); }
  }
});
app.post('/api/chat/new', requireAuth, requireSubscription, async (req, res) => {
  await db.prepare('UPDATE users SET opencode_session_id = NULL WHERE id = ?').run(req.authUser.id);
  res.json({ ok: true });
});

const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 30, fields: 2, fieldSize: 40 * 1024 } }).array('files', 30);
app.post('/api/workspace/upload', requireAuth, requireSubscription, (req, res, next) => {
  uploadMiddleware(req, res, err => { if (err) return res.status(400).json({ error: 'Unable to upload files. The limit is 30 files, up to 5 MB each.' }); next(); });
}, async (req, res) => {
  try {
    const user = await selectUserById.get(req.authUser.id);
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

let appServer = null;
let proxyListening = false;
async function startServer() {
  try {
    await initializeDatabase();
  } catch (err) {
    // Some PostgreSQL/driver layers wrap the TLS error as `cause` and omit a
    // top-level code. Match both structured codes and the known TLS message so
    // Render logs still explain the certificate failure rather than only exit 1.
    const errorChain = [err, err && err.cause, err && err.originalError].filter(Boolean);
    const tlsCodes = ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'];
    const errorCode = String(((errorChain.find(item => tlsCodes.includes(String(item.code || ''))) || errorChain.find(item => item.code)) || {}).code || '');
    const errorText = errorChain.map(item => String(item.message || '')).join(' | ');
    const isCertificateError = tlsCodes.includes(errorCode) || /self-signed certificate in certificate chain|unable to verify the first certificate|unable to get local issuer certificate|certificate verify failed/i.test(errorText);
    if (isCertificateError) {
      console.error('DATABASE_TLS_DIAGNOSTIC:', JSON.stringify({
        releaseId: CODECRAFT_RELEASE_ID,
        code: errorCode || null,
        host: databaseHost,
        tlsMode: databaseTlsMode,
        tlsModeSetting: DATABASE_URL ? String(process.env.SUPABASE_TLS_MODE || 'verify').trim().toLowerCase() : 'not-applicable',
        caPathConfigured: Boolean(process.env.SUPABASE_CA_CERT_PATH || process.env.PGSSLROOTCERT),
        inlineCaConfigured: Boolean(String(process.env.SUPABASE_CA_CERT || '').trim()),
        message: 'The PostgreSQL endpoint certificate chain is not trusted. Verify the root CA belongs to this exact database endpoint, or use SUPABASE_TLS_MODE=compat only temporarily for a Supabase host.'
      }));
    }
    throw err;
  }
  await bootstrapAdminAccount();
  appServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CodeCraft web service listening on port ${PORT}`);
    console.log(`Database backend: ${db.isPostgres ? 'Supabase PostgreSQL' : 'local SQLite fallback'}`);
    if (!aiConfigReady()) console.warn('No server-wide default AI API is configured; user-specific API credentials assigned in /admin are supported.');
    console.log('Subscription approvals are handled manually in /admin.');
  });
  proxyServer.listen(AI_PROXY_PORT, AI_PROXY_HOST, () => { proxyListening = true; console.log('Internal AI gateway listening on loopback.'); });
}
startServer().catch(err => {
  console.error('Application startup failed:', JSON.stringify({
    message: err && err.message ? err.message : 'unknown error',
    code: err && err.code || null,
    databaseTlsMode,
    databaseTlsModeSetting: DATABASE_URL ? String(process.env.SUPABASE_TLS_MODE || 'verify').trim().toLowerCase() : 'not-applicable',
    databaseHost,
    release: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown',
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : null
  }));
  process.exit(1);
});

function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping coding workers.`);
  for (const userId of [...instances.keys()]) stopInstance(userId);
  if (proxyListening) proxyServer.close();
  const finish = async () => { try { await db.close(); } catch {} process.exit(0); };
  if (appServer) appServer.close(finish); else finish();
  setTimeout(() => process.exit(0), 6_000).unref();
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('unhandledRejection', err => console.error('Unhandled background error:', err && err.message ? err.message : 'unknown error'));
