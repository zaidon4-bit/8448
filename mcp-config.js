'use strict';

const path = require('node:path');

// Validate the official OpenCode MCP config subset accepted by the web admin.
// Only administrators can write this data and the whole configuration is encrypted at rest.
function validateMcpConfig(input) {

  let parsed = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > 24_000) throw new Error('MCP_CONFIG_TOO_LARGE');
    try { parsed = JSON.parse(input); } catch { throw new Error('MCP_CONFIG_INVALID_JSON'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP_CONFIG_INVALID_OBJECT');
  const names = Object.keys(parsed);
  if (names.length > 12) throw new Error('MCP_CONFIG_TOO_MANY_SERVERS');
  const output = {};
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('MCP_CONFIG_INVALID_NAME');
    const source = parsed[name];
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('MCP_CONFIG_INVALID_SERVER');
    const allowed = new Set(['type', 'url', 'command', 'environment', 'headers', 'enabled', 'timeout', 'cwd', 'oauth']);
    if (Object.keys(source).some(key => !allowed.has(key))) throw new Error('MCP_CONFIG_UNKNOWN_OPTION');
    const cfg = { enabled: source.enabled !== false };
    if (source.timeout !== undefined) {
      const timeout = Number(source.timeout);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('MCP_CONFIG_INVALID_TIMEOUT');
      cfg.timeout = timeout;
    }
    const type = source.type || (Array.isArray(source.command) ? 'local' : (source.url ? 'remote' : ''));
    if (type === 'remote') {
      const rawUrl = String(source.url || '').trim();
      let remote;
      try { remote = new URL(rawUrl); } catch { throw new Error('MCP_CONFIG_INVALID_URL'); }
      if (!['https:', ...(process.env.NODE_ENV === 'production' ? [] : ['http:'])].includes(remote.protocol) || remote.username || remote.password || remote.hash) throw new Error('MCP_CONFIG_INVALID_URL');
      cfg.type = 'remote'; cfg.url = remote.toString();
      if (source.headers !== undefined) {
        if (!source.headers || typeof source.headers !== 'object' || Array.isArray(source.headers) || Object.keys(source.headers).length > 30) throw new Error('MCP_CONFIG_INVALID_HEADERS');
        cfg.headers = {};
        for (const [header, value] of Object.entries(source.headers)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(header) || typeof value !== 'string' || value.length > 4000 || /[\r\n]/.test(value)) throw new Error('MCP_CONFIG_INVALID_HEADERS');
          cfg.headers[header] = value;
        }
      }
      if (source.oauth === false) cfg.oauth = false;
      else if (source.oauth !== undefined) {
        if (!source.oauth || typeof source.oauth !== 'object' || Array.isArray(source.oauth)) throw new Error('MCP_CONFIG_INVALID_OAUTH');
        if (Object.keys(source.oauth).some(key => !['clientId', 'clientSecret', 'scope'].includes(key))) throw new Error('MCP_CONFIG_INVALID_OAUTH');
        cfg.oauth = {};
        for (const [key, value] of Object.entries(source.oauth)) {
          if (typeof value !== 'string' || value.length > 4000 || /[\r\n]/.test(value)) throw new Error('MCP_CONFIG_INVALID_OAUTH');
          cfg.oauth[key] = value;
        }
      }
    } else if (type === 'local') {
      if (!Array.isArray(source.command) || !source.command.length || source.command.length > 32 || source.command.some(arg => typeof arg !== 'string' || !arg.length || arg.length > 1000 || arg.includes('\0'))) throw new Error('MCP_CONFIG_INVALID_COMMAND');
      cfg.type = 'local'; cfg.command = source.command;
      if (source.cwd !== undefined) {
        if (typeof source.cwd !== 'string' || !source.cwd.length || path.isAbsolute(source.cwd) || source.cwd.split(/[\\/]/).includes('..')) throw new Error('MCP_CONFIG_INVALID_CWD');
        cfg.cwd = source.cwd;
      }
      if (source.environment !== undefined) {
        if (!source.environment || typeof source.environment !== 'object' || Array.isArray(source.environment) || Object.keys(source.environment).length > 40) throw new Error('MCP_CONFIG_INVALID_ENV');
        cfg.environment = {};
        for (const [key, value] of Object.entries(source.environment)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || value.length > 4000 || value.includes('\0')) throw new Error('MCP_CONFIG_INVALID_ENV');
          cfg.environment[key] = value;
        }
      }
    } else throw new Error('MCP_CONFIG_INVALID_TYPE');
    output[name] = cfg;
  }
  return output;
}

module.exports = { validateMcpConfig };
