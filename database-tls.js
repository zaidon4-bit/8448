'use strict';

const fs = require('node:fs');
const tls = require('node:tls');

const SSL_QUERY_KEYS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'];

function sanitizeConnectionStringForExplicitTls(databaseUrl) {
  const url = new URL(databaseUrl);
  for (const key of SSL_QUERY_KEYS) url.searchParams.delete(key);
  return url.toString();
}

function configurePostgresTls(databaseUrl, env = process.env, readFile = fs.readFileSync) {
  const url = new URL(databaseUrl);
  const isSupabaseHost = url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.pooler.supabase.com');
  const mode = String(env.SUPABASE_TLS_MODE || 'verify').trim().toLowerCase();

  if (mode === 'compat') {
    if (!isSupabaseHost) throw new Error('SUPABASE_TLS_MODE=compat is only supported for Supabase PostgreSQL endpoints.');
    // Explicit, temporary fallback: require TLS encryption but skip certificate
    // identity verification. Configure TLS through pg's `ssl` option directly;
    // do not depend on parsing `sslmode`/`uselibpqcompat` query parameters.
    return {
      connectionString: sanitizeConnectionStringForExplicitTls(databaseUrl),
      ssl: { rejectUnauthorized: false },
      mode: 'encrypted-unverified-compat'
    };
  }
  if (mode !== 'verify') throw new Error('SUPABASE_TLS_MODE must be either verify or compat.');

  // Accept the standard libpq sslrootcert URL parameter as well as Render env vars.
  // The URL is sanitized before handing it to node-postgres so its parser cannot
  // silently override the explicit TLS options below.
  const urlCaPath = String(url.searchParams.get('sslrootcert') || '').trim();
  const caPath = String(env.SUPABASE_CA_CERT_PATH || env.PGSSLROOTCERT || urlCaPath || '').trim();
  const inlineCa = String(env.SUPABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
  let ca = inlineCa;
  if (caPath) {
    try { ca = String(readFile(caPath, 'utf8')).trim(); }
    catch {
      throw new Error(`Supabase root CA file is missing or unreadable at ${caPath}. Add the Supabase root certificate as a Render Secret File and set SUPABASE_CA_CERT_PATH to its runtime path.`);
    }
  }
  if (ca && !ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('SUPABASE_CA_CERT must contain a PEM certificate beginning with -----BEGIN CERTIFICATE-----.');
  }
  if (isSupabaseHost && !ca) {
    throw new Error('Supabase TLS certificate verification needs the project root CA. In Supabase Dashboard > Database Settings > SSL Configuration, download the root certificate; add it to Render as Secret File supabase-ca.crt and set SUPABASE_CA_CERT_PATH=/etc/secrets/supabase-ca.crt. Do not disable TLS verification globally.');
  }

  // Strip URL SSL parameters so they cannot override the explicitly configured
  // CA certificate object in node-postgres.
  return {
    connectionString: sanitizeConnectionStringForExplicitTls(databaseUrl),
    // Supplying `ca` replaces Node's default CA list. Include Node's bundled
    // public roots as well as the project's custom Supabase root so a custom
    // trust anchor does not accidentally remove ordinary trusted roots.
    ssl: { rejectUnauthorized: true, ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}) },
    mode: ca ? 'verified-root-ca' : 'verified-system-roots'
  };
}

module.exports = { configurePostgresTls, sanitizeConnectionStringForExplicitTls };
