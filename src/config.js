'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Minimal .env loader (no dependency). Never overrides real environment variables. */
function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const num = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const list = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
const bool = (raw, fallback) => (raw === undefined || raw === '' ? fallback : !/^(0|false|no|off)$/i.test(String(raw).trim()));

function parseCors(raw) {
  const v = list(raw === undefined ? '*' : raw);
  if (!v.length || v.includes('*')) return '*';
  return v;
}

function parseTrustProxy(raw) {
  const v = String(raw === undefined ? '' : raw).trim().toLowerCase();
  if (!v || v === 'false') return 0;
  if (v === 'true') return 1;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Build the runtime configuration from an env object. */
function buildConfig(env = process.env) {
  return {
    port: num(env, 'PORT', 8000),
    host: env.HOST || '0.0.0.0',
    apiKeys: list(env.API_KEYS),
    publicUrl: String(env.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cors: parseCors(env.CORS_ORIGIN),
    rateWindowMs: num(env, 'RATE_LIMIT_WINDOW_MS', 60_000) || 60_000,
    rateMax: num(env, 'RATE_LIMIT_MAX', 60) || 60,
    mediaRateMax: num(env, 'FETCH_MEDIA_RATE_LIMIT_MAX', 15) || 15,
    downloadTimeoutMs: num(env, 'DOWNLOAD_TIMEOUT_MS', 25_000) || 25_000,
    cacheTtlMs: num(env, 'CACHE_TTL_MS', 300_000),
    cacheMax: num(env, 'CACHE_MAX_ENTRIES', 300) || 300,
    media: {
      allowedHosts: list(env.FETCH_MEDIA_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
      maxBytes: num(env, 'FETCH_MEDIA_MAX_BYTES', 0),
      timeoutMs: num(env, 'FETCH_MEDIA_TIMEOUT_MS', 20_000) || 20_000,
      allowPrivate: false, // only ever enabled by tests
    },
    serveTester: bool(env.SERVE_TESTER, true),
    provider: (env.PROVIDER || 'btch').toLowerCase(),
  };
}

module.exports = { loadDotEnv, buildConfig };
