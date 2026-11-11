'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ApiError, bad } = require('./errors');
const { PLATFORMS, hostMatches } = require('./platforms');
const { normalize, truncate } = require('./normalize');
const { Cache } = require('./cache');
const { createLimiter } = require('./limiter');
const { streamMedia, safeFilename } = require('./proxy');

const VERSION = require('../package.json').version;
const LIMIT_DEFAULT = 5;
const LIMIT_MAX = 50;
const MAX_INPUT_LEN = 2000;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createServer(cfg, { provider }) {
  const cache = new Cache({ ttlMs: cfg.cacheTtlMs, maxEntries: cfg.cacheMax });
  const apiLimiter = createLimiter({ windowMs: cfg.rateWindowMs, max: cfg.rateMax });
  const mediaLimiter = createLimiter({ windowMs: cfg.rateWindowMs, max: cfg.mediaRateMax });
  const keyHashes = cfg.apiKeys.map(sha);
  const testerHtml = cfg.serveTester ? safeRead(path.join(__dirname, '..', 'public', 'index.html')) : null;
  let deepProbe = { at: 0, result: null };

  // ---------- helpers ----------
  function clientIp(req) {
    if (cfg.trustProxy > 0) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[Math.max(0, xff.length - cfg.trustProxy)];
    }
    return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  }

  function baseUrl(req) {
    if (cfg.publicUrl) return cfg.publicUrl;
    const t = cfg.trustProxy > 0;
    const proto = (t && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || 'http';
    const host = (t && String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()) || req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const h = {
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'X-API-Key, Content-Type, Range',
      'access-control-expose-headers': 'X-Request-Id, X-Cache, Content-Disposition, Content-Range, Accept-Ranges, RateLimit-Remaining, Retry-After',
      'access-control-max-age': '86400',
    };
    if (cfg.cors === '*') h['access-control-allow-origin'] = '*';
    else if (origin && cfg.cors.includes(origin)) {
      h['access-control-allow-origin'] = origin;
      h.vary = 'Origin';
    }
    return h;
  }

  function authorized(req, url) {
    if (!keyHashes.length) return true;
    const given = req.headers['x-api-key'] || url.searchParams.get('key') || '';
    if (!given) return false;
    const g = sha(given);
    // constant-time compare against every key (no early exit)
    return keyHashes.reduce((ok, k) => crypto.timingSafeEqual(k, g) || ok, false);
  }

  function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  // ---------- route handlers ----------
  function listPlatforms() {
    const platforms = Object.entries(PLATFORMS)
      .filter(([, p]) => provider.has(p.fn))
      .map(([key, p]) => ({
        key,
        input: p.input,
        example: p.example,
        ...(p.list ? { list: true } : {}),
        ...(p.limit ? { supportsLimit: true } : {}),
        ...(p.deprecated ? { deprecated: true } : {}),
      }));
    return { success: true, count: platforms.length, platforms };
  }

  async function health(url) {
    const body = { success: true, status: 'ok', version: VERSION, provider: provider.name, uptime: Math.round(process.uptime()), cache: cache.stats() };
    if (url.searchParams.get('deep') !== '1') return { status: 200, body };

    // deep probe: one real search, reused for 60s, to see if the upstream scraper still works
    if (Date.now() - deepProbe.at > 60_000) {
      const t0 = Date.now();
      try {
        const raw = await withTimeout(provider.call('yts', 'music'), cfg.downloadTimeoutMs);
        const ok = Boolean(normalize('youtube-search', PLATFORMS['youtube-search'], raw));
        deepProbe = { at: Date.now(), result: { ok, latencyMs: Date.now() - t0, ...(ok ? {} : { error: 'Upstream answered with no results.' }) } };
      } catch (e) {
        deepProbe = { at: Date.now(), result: { ok: false, latencyMs: Date.now() - t0, error: String(e.message || e).slice(0, 200) } };
      }
    }
    body.upstream = deepProbe.result;
    if (!deepProbe.result.ok) { body.success = false; body.status = 'degraded'; }
    return { status: body.success ? 200 : 503, body };
  }

  function parseInput(platformKey, platform, url) {
    const q = url.searchParams;
    let input;
    if (platform.input === 'query') input = q.get('query') ?? q.get('q');
    else if (platform.input === 'url_or_query') input = q.get('url') ?? q.get('query') ?? q.get('q');
    else input = q.get('url');
    input = (input || '').trim();

    const field = platform.input === 'query' ? 'query' : platform.input === 'url_or_query' ? 'url (or query)' : 'url';
    if (!input) throw bad('MISSING_PARAM', `Missing required "${field}" parameter. Example: ${platform.example}`);
    if (input.length > MAX_INPUT_LEN) throw bad('INPUT_TOO_LONG', `"${field}" is too long.`);

    const isUrlLike = platform.input === 'url' || (platform.input === 'url_or_query' && /^https?:\/\//i.test(input));
    if (isUrlLike) {
      let u;
      try { u = new URL(input); } catch { throw bad('BAD_URL', 'The "url" parameter is not a valid URL.'); }
      if (!/^https?:$/.test(u.protocol)) throw bad('BAD_URL', 'Only http(s) URLs are supported.');
      if (platform.hosts && !hostMatches(u.hostname, platform.hosts)) {
        throw bad('WRONG_PLATFORM', `This URL does not look like a ${platformKey} link. Example: ${platform.example}`);
      }
    }
    return input;
  }

  /** YouTube's upstream scraper is picky: try a few equivalent URL shapes. */
  function candidates(platformKey, input) {
    if (platformKey !== 'youtube') return [input];
    const m = input.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/i);
    return m ? [`https://youtube.com/watch?v=${m[1]}`, `https://www.youtube.com/watch?v=${m[1]}`, input] : [input];
  }

  async function fetchDownload(platformKey, platform, input, limit) {
    let raw = null;
    let data = null;
    let lastErr = null;
    for (const candidate of candidates(platformKey, input)) {
      try {
        raw = await withTimeout(provider.call(platform.fn, candidate), cfg.downloadTimeoutMs);
        if (platform.limit && limit) truncate(platformKey, raw, limit);
        data = normalize(platformKey, platform, raw);
        if (data) break;
      } catch (e) {
        lastErr = e;
        if (e instanceof ApiError) throw e;
      }
    }
    if (!data) {
      if (lastErr && raw == null) {
        const timedOut = lastErr.code === 'ETIMEDOUT';
        throw new ApiError(timedOut ? 504 : 502, timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
          timedOut ? 'The downloader took too long to answer.' : `The downloader failed: ${String(lastErr.message || lastErr).slice(0, 200)}`);
      }
      if (platform.list) data = { kind: 'list', items: [] };
      else if (platform.strict === false) data = null; // best-effort platforms: pass raw through
      else throw new ApiError(502, 'NO_MEDIA_FOUND', 'No downloadable media was found. The post may be private, deleted, or the provider is temporarily failing.');
    }
    return { raw, data };
  }

  /** Add an absolute `downloadUrl` (our proxy) to every directly downloadable item. */
  function addProxyLinks(data, req, key) {
    if (!data) return data;
    const base = baseUrl(req);
    const link = (url, name) =>
      `${base}/api/fetch-media?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(name)}` + (key ? `&key=${encodeURIComponent(key)}` : '');
    const ext = (u, type) => {
      const m = u.split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
      return m ? m[1].toLowerCase() : { video: 'mp4', audio: 'mp3', image: 'jpg' }[type] || 'bin';
    };
    const clone = JSON.parse(JSON.stringify(data));
    if (clone.kind === 'media') {
      const stem = safeFilename(clone.title, 'download').slice(0, 60);
      for (const m of clone.media) m.downloadUrl = link(m.url, `${stem}.${ext(m.url, m.type)}`);
    } else {
      for (const it of clone.items) {
        if (it.downloadable) it.downloadUrl = link(it.url, `${safeFilename(it.title, 'download').slice(0, 60)}.${ext(it.url, it.type)}`);
      }
    }
    return clone;
  }

  async function download(req, url, platformKey, key) {
    const platform = Object.prototype.hasOwnProperty.call(PLATFORMS, platformKey) ? PLATFORMS[platformKey] : null;
    if (!platform || !provider.has(platform.fn)) {
      throw new ApiError(404, 'UNKNOWN_PLATFORM', `Unknown or unavailable platform "${platformKey}". See /api/platforms.`);
    }
    const input = parseInput(platformKey, platform, url);
    let limit;
    if (platform.limit) {
      const n = Number.parseInt(url.searchParams.get('limit'), 10);
      limit = Number.isFinite(n) && n >= 1 ? Math.min(n, LIMIT_MAX) : LIMIT_DEFAULT;
    }
    const { value, hit } = await cache.wrap(`${platformKey}|${limit || ''}|${input}`, () => fetchDownload(platformKey, platform, input, limit));

    const body = { success: true, platform: platformKey, input, ...(limit ? { limit } : {}), data: addProxyLinks(value.data, req, key) };
    if (url.searchParams.get('raw') === '1' || value.data === null) body.raw = value.raw;
    return { body, hit };
  }

  async function fetchMedia(req, res, url, headers) {
    const raw = url.searchParams.get('url');
    if (!raw) throw bad('MISSING_PARAM', 'Missing required "url" parameter.');
    let target;
    try { target = new URL(raw); } catch { throw bad('BAD_URL', 'The "url" parameter is not a valid URL.'); }
    const filename = safeFilename(url.searchParams.get('filename'), safeFilename(decodeURIComponent(target.pathname.split('/').pop() || ''), 'download'));
    await streamMedia(req, res, { target, filename, opts: cfg.media, baseHeaders: headers });
  }

  // ---------- main handler ----------
  async function handle(req, res) {
    const id = /^[A-Za-z0-9._-]{8,64}$/.test(req.headers['x-request-id'] || '') ? req.headers['x-request-id'] : crypto.randomUUID();
    const started = Date.now();
    const ip = clientIp(req);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { url = new URL('http://localhost/'); }
    const baseHeaders = { ...SECURITY_HEADERS, ...corsHeaders(req), 'x-request-id': id };

    res.on('finish', () => {
      if (url.pathname !== '/api/health') {
        console.log(`${new Date().toISOString()} ${id.slice(0, 8)} ${ip} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });

    const send = (status, body, extra) => sendJson(res, status, body, { ...baseHeaders, ...extra });
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, baseHeaders); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.');

      const p = url.pathname.replace(/\/+$/, '') || '/';

      if (p === '/' || p === '/index.html') {
        if (!testerHtml) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
        res.writeHead(200, { ...baseHeaders, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src * data:; connect-src 'self'" });
        return res.end(req.method === 'HEAD' ? undefined : testerHtml);
      }
      if (p === '/api/health') {
        const { status, body } = await health(url);
        return send(status, body);
      }
      if (!p.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', 'Not found.');

      // ---- everything below needs the API key + rate limit ----
      if (!authorized(req, url)) throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key. Send it in the "X-API-Key" header.');
      const isMedia = p === '/api/fetch-media';
      const rl = (isMedia ? mediaLimiter : apiLimiter).hit(`${isMedia ? 'm' : 'a'}|${ip}`);
      baseHeaders['ratelimit-limit'] = String(rl.limit);
      baseHeaders['ratelimit-remaining'] = String(rl.remaining);
      if (!rl.ok) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests, please slow down.', { retryAfterSec: rl.resetSec });

      if (p === '/api/platforms') return send(200, listPlatforms());
      if (isMedia) return await fetchMedia(req, res, url, baseHeaders);

      const m = p.match(/^\/api\/download\/([^/]+)$/);
      if (m) {
        const key = req.headers['x-api-key'] ? '' : url.searchParams.get('key') || '';
        const { body, hit } = await download(req, url, decodeURIComponent(m[1]).toLowerCase(), key);
        return send(200, body, { 'x-cache': hit ? 'HIT' : 'MISS' });
      }
      throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', 'Internal server error.');
      if (!(err instanceof ApiError)) console.error(`[${id}]`, err);
      if (res.headersSent) return res.destroy();
      const extra = e.extra && e.extra.retryAfterSec ? { 'retry-after': String(e.extra.retryAfterSec) } : {};
      send(e.status, { success: false, error: { code: e.code, message: e.message, status: e.status, requestId: id } }, extra);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); try { res.destroy(); } catch {} });
  });
  server.requestTimeout = 0; // long file downloads must not be cut off
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;
  server.on('close', () => { apiLimiter.stop(); mediaLimiter.stop(); });
  return server;
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(t));
}

function safeRead(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

module.exports = { createServer };
