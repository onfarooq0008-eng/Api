'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildConfig } = require('../src/config');
const { createServer } = require('../src/app');
const { createMockProvider } = require('../src/provider');
const { isPrivateAddress, assertPublicTarget } = require('../src/ssrf');
const { normalize } = require('../src/normalize');
const { PLATFORMS } = require('../src/platforms');

function start(envOverrides = {}, mediaOverrides = {}, provider = createMockProvider()) {
  const cfg = buildConfig({ PROVIDER: 'mock', API_KEYS: 'secret1,secret2', ...envOverrides });
  Object.assign(cfg.media, mediaOverrides);
  const server = createServer(cfg, { provider });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  );
}
const get = (base, p, headers = {}) => fetch(base + p, { headers });
const KEY = { 'x-api-key': 'secret1' };

test('health is public and reports status', async () => {
  const { server, base } = await start();
  const r = await get(base, '/api/health');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.status, 'ok');
  assert.ok(r.headers.get('x-request-id'));
  server.close();
});

test('API key is required and either configured key works', async () => {
  const { server, base } = await start();
  assert.equal((await get(base, '/api/platforms')).status, 401);
  assert.equal((await get(base, '/api/platforms', { 'x-api-key': 'nope' })).status, 401);
  assert.equal((await get(base, '/api/platforms', KEY)).status, 200);
  assert.equal((await get(base, '/api/platforms', { 'x-api-key': 'secret2' })).status, 200);
  assert.equal((await get(base, '/api/platforms?key=secret1')).status, 200);
  server.close();
});

test('no API_KEYS = open API', async () => {
  const { server, base } = await start({ API_KEYS: '' });
  assert.equal((await get(base, '/api/platforms')).status, 200);
  server.close();
});

test('platforms list', async () => {
  const { server, base } = await start();
  const j = await (await get(base, '/api/platforms', KEY)).json();
  assert.equal(j.success, true);
  assert.equal(j.count, Object.keys(PLATFORMS).length);
  assert.ok(j.platforms.find((p) => p.key === 'tiktok'));
  server.close();
});

test('download: tiktok normalizes video + audio + proxy links', async () => {
  const { server, base } = await start();
  const r = await get(base, '/api/download/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/1'), KEY);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-cache'), 'MISS');
  assert.equal(j.data.kind, 'media');
  assert.equal(j.data.title, 'Mock TikTok video');
  const types = j.data.media.map((m) => m.type).sort();
  assert.deepEqual(types, ['audio', 'video']);
  assert.match(j.data.media[0].downloadUrl, /\/api\/fetch-media\?url=/);
  // cached second time
  const r2 = await get(base, '/api/download/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/1'), KEY);
  assert.equal(r2.headers.get('x-cache'), 'HIT');
  server.close();
});

test('download: twitter hd/sd, facebook, youtube, douyin all yield media', async () => {
  const { server, base } = await start();
  const cases = {
    twitter: 'https://x.com/u/status/1',
    facebook: 'https://www.facebook.com/watch/?v=1',
    youtube: 'https://youtu.be/dQw4w9WgXcQ',
    douyin: 'https://v.douyin.com/abc/',
    soundcloud: 'https://soundcloud.com/a/b',
    gdrive: 'https://drive.google.com/file/d/abc/view',
    capcut: 'https://www.capcut.com/template-detail/1',
    instagram: 'https://www.instagram.com/reel/abc/',
  };
  for (const [p, u] of Object.entries(cases)) {
    const j = await (await get(base, `/api/download/${p}?url=` + encodeURIComponent(u), KEY)).json();
    assert.equal(j.success, true, p);
    assert.ok(j.data.media.length >= 1, `${p} had no media`);
  }
  server.close();
});

test('download: search platforms honour limit', async () => {
  const { server, base } = await start();
  let j = await (await get(base, '/api/download/youtube-search?query=lofi&limit=3', KEY)).json();
  assert.equal(j.data.kind, 'list');
  assert.equal(j.data.items.length, 3);
  assert.equal(j.data.items[0].downloadable, false);
  j = await (await get(base, '/api/download/youtube-search?query=lofi', KEY)).json();
  assert.equal(j.data.items.length, 5); // default
  j = await (await get(base, '/api/download/pinterest?query=cats&limit=2', KEY)).json();
  assert.equal(j.data.items.length, 2);
  assert.ok(j.data.items[0].downloadUrl);
  server.close();
});

test('download: validation errors', async () => {
  const { server, base } = await start();
  let r = await get(base, '/api/download/tiktok', KEY);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'MISSING_PARAM');
  r = await get(base, '/api/download/tiktok?url=notaurl', KEY);
  assert.equal((await r.json()).error.code, 'BAD_URL');
  r = await get(base, '/api/download/tiktok?url=' + encodeURIComponent('https://evil.example/x'), KEY);
  assert.equal((await r.json()).error.code, 'WRONG_PLATFORM');
  r = await get(base, '/api/download/nope?url=x', KEY);
  assert.equal(r.status, 404);
  r = await get(base, '/api/download/__proto__?url=x', KEY);
  assert.equal(r.status, 404);
  server.close();
});

test('upstream failure maps to 502 and is not cached', async () => {
  let calls = 0;
  const provider = { name: 'x', has: () => true, init: async () => {}, call: async () => { calls++; throw new Error('boom'); } };
  const { server, base } = await start({}, {}, provider);
  const u = '/api/download/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/1');
  assert.equal((await get(base, u, KEY)).status, 502);
  assert.equal((await get(base, u, KEY)).status, 502);
  assert.equal(calls, 2);
  server.close();
});

test('upstream timeout maps to 504', async () => {
  const provider = { name: 'x', has: () => true, init: async () => {}, call: () => new Promise(() => {}) };
  const { server, base } = await start({ DOWNLOAD_TIMEOUT_MS: '50' }, {}, provider);
  const r = await get(base, '/api/download/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/1'), KEY);
  assert.equal(r.status, 504);
  server.close();
});

test('concurrent identical requests share one upstream call', async () => {
  let calls = 0;
  const mock = createMockProvider();
  const provider = { ...mock, call: async (fn, i) => { calls++; await new Promise((r) => setTimeout(r, 50)); return mock.call(fn, i); } };
  const { server, base } = await start({}, {}, provider);
  const u = '/api/download/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/1');
  await Promise.all([get(base, u, KEY), get(base, u, KEY), get(base, u, KEY)]);
  assert.equal(calls, 1);
  server.close();
});

test('rate limiting returns 429 with Retry-After', async () => {
  const { server, base } = await start({ RATE_LIMIT_MAX: '3' });
  for (let i = 0; i < 3; i++) assert.equal((await get(base, '/api/platforms', KEY)).status, 200);
  const r = await get(base, '/api/platforms', KEY);
  assert.equal(r.status, 429);
  assert.ok(r.headers.get('retry-after'));
  server.close();
});

test('unknown route 404 JSON, POST 405, OPTIONS 204 with CORS', async () => {
  const { server, base } = await start();
  const r = await get(base, '/nothing');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).success, false);
  assert.equal((await fetch(base + '/api/platforms', { method: 'POST', headers: KEY })).status, 405);
  const o = await fetch(base + '/api/platforms', { method: 'OPTIONS' });
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('access-control-allow-origin'), '*');
  server.close();
});

test('tester page is served', async () => {
  const { server, base } = await start();
  const r = await get(base, '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /DLHub API tester/);
  server.close();
});

// ---------------- SSRF ----------------
test('ssrf: private/reserved addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('ssrf: assertPublicTarget rejects bad targets', () => {
  const bad = ['http://localhost/x', 'http://127.0.0.1/', 'http://[::1]/', 'http://metadata.internal/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://169.254.169.254/latest', 'ftp://example.com/'];
  for (const u of bad) assert.throws(() => assertPublicTarget(new URL(u)), (e) => e.status === 400, u);
  assert.doesNotThrow(() => assertPublicTarget(new URL('https://cdn.example.com/a.mp4')));
  assert.throws(() => assertPublicTarget(new URL('https://other.com/a'), { allowedHosts: ['cdn.example.com'] }));
  assert.doesNotThrow(() => assertPublicTarget(new URL('https://a.cdn.example.com/a'), { allowedHosts: ['cdn.example.com'] }));
});

test('fetch-media refuses internal targets', async () => {
  const { server, base } = await start();
  for (const t of ['http://127.0.0.1:1/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/']) {
    const r = await get(base, '/api/fetch-media?url=' + encodeURIComponent(t), KEY);
    assert.equal(r.status, 400, t);
  }
  server.close();
});

// ---------------- file proxy against a local origin ----------------
function origin(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

test('fetch-media streams file, sets attachment name, supports Range', async () => {
  const body = Buffer.from('0123456789'.repeat(100));
  const o = await origin((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: '/f.mp4' }); return res.end(); }
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const s = +m[1], e = m[2] ? +m[2] : body.length - 1;
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${s}-${e}/${body.length}`, 'content-length': e - s + 1 });
      return res.end(body.subarray(s, e + 1));
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length, 'accept-ranges': 'bytes' });
    res.end(body);
  });
  const { server, base } = await start({}, { allowPrivate: true });

  let r = await get(base, '/api/fetch-media?url=' + encodeURIComponent(o.url + '/redir') + '&filename=' + encodeURIComponent('my/vid:eo?.mp4'), KEY);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="my_vid_eo_\.mp4"/);
  assert.equal(Buffer.from(await r.arrayBuffer()).length, 1000);

  r = await get(base, '/api/fetch-media?url=' + encodeURIComponent(o.url + '/f.mp4'), { ...KEY, range: 'bytes=10-19' });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), '0123456789');
  assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');

  r = await get(base, '/api/fetch-media?url=' + encodeURIComponent(o.url + '/page'), KEY);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, 'NOT_MEDIA');

  server.close(); o.s.close();
});

test('fetch-media enforces max size via content-length', async () => {
  const o = await origin((req, res) => { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 5000 }); res.end(Buffer.alloc(5000)); });
  const { server, base } = await start({}, { allowPrivate: true, maxBytes: 1000 });
  const r = await get(base, '/api/fetch-media?url=' + encodeURIComponent(o.url + '/big'), KEY);
  assert.equal(r.status, 413);
  server.close(); o.s.close();
});

// ---------------- normalizer ----------------
test('normalize: unrelated profile URLs are ignored, covers become thumbnail', () => {
  const raw = { title: 'T', author: { name: 'Bob' }, profile: 'https://x.com/bob', cover: 'https://c.com/a.jpg', video: 'https://v.com/a.mp4' };
  const out = normalize('threads', PLATFORMS.threads, raw);
  assert.equal(out.media.length, 1);
  assert.equal(out.thumbnail, 'https://c.com/a.jpg');
  assert.equal(out.author, 'Bob');
});

test('normalize: image-only posts fall back to images', () => {
  const out = normalize('xiaohongshu', PLATFORMS.xiaohongshu, { images: ['https://i.com/1.jpg', 'https://i.com/2.jpg'] });
  assert.equal(out.media.length, 2);
  assert.equal(out.media[0].type, 'image');
});

test('normalize: empty / junk returns null', () => {
  assert.equal(normalize('tiktok', PLATFORMS.tiktok, {}), null);
  assert.equal(normalize('tiktok', PLATFORMS.tiktok, null), null);
  assert.equal(normalize('tiktok', PLATFORMS.tiktok, { status: true, developer: 'x' }), null);
});
