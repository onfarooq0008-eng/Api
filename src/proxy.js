'use strict';
const http = require('node:http');
const https = require('node:https');
const { ApiError } = require('./errors');
const { assertPublicTarget, createGuardedLookup } = require('./ssrf');

const MAX_REDIRECTS = 5;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/** Safe attachment filename: no path separators / control chars / quotes. */
function safeFilename(name, fallback = 'download') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Open the upstream connection, following (and re-checking) up to 5 redirects. */
function openUpstream(target, { range, opts, signalReq }) {
  const lookup = createGuardedLookup({ allowPrivate: opts.allowPrivate });
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (u) => {
      try {
        assertPublicTarget(u, opts);
      } catch (e) {
        return reject(e);
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method: 'GET',
        lookup,
        headers: { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity', ...(range ? { range } : {}) },
      });
      signalReq(req);
      const timer = setTimeout(() => req.destroy(new ApiError(504, 'UPSTREAM_TIMEOUT', 'The media server took too long to answer.')), opts.timeoutMs);
      req.on('response', (up) => {
        clearTimeout(timer);
        const st = up.statusCode;
        if (st >= 300 && st < 400 && up.headers.location) {
          up.resume();
          if (++hops > MAX_REDIRECTS) return reject(new ApiError(502, 'TOO_MANY_REDIRECTS', 'Too many redirects.'));
          let next;
          try { next = new URL(up.headers.location, u); } catch { return reject(new ApiError(502, 'BAD_REDIRECT', 'Bad redirect from media server.')); }
          return go(next);
        }
        resolve(up);
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        if (e instanceof ApiError) return reject(e);
        if (e.code === 'ERR_INVALID_URL') return reject(new ApiError(400, 'BAD_URL', 'Invalid URL.'));
        reject(new ApiError(502, 'UPSTREAM_ERROR', `Could not reach media server (${e.code || e.message}).`));
      });
      req.end();
    };
    go(target);
  });
}

/**
 * Stream a remote media file to the client as a download.
 * Supports Range requests, so Android's DownloadManager / ExoPlayer can
 * resume downloads and seek.
 */
async function streamMedia(req, res, { target, filename, opts, baseHeaders }) {
  let upstreamReq = null;
  let finished = false;
  res.on('close', () => {
    if (!finished && upstreamReq) upstreamReq.destroy();
  });

  const up = await openUpstream(target, {
    range: req.headers.range,
    opts,
    signalReq: (r) => { upstreamReq = r; },
  });

  const status = up.statusCode;
  if (status !== 200 && status !== 206) {
    up.resume();
    throw new ApiError(status === 404 ? 404 : status === 416 ? 416 : 502, 'UPSTREAM_STATUS', `Media server answered HTTP ${status}.`);
  }
  const ctype = String(up.headers['content-type'] || '').toLowerCase();
  if (/^(text\/|application\/json|application\/xml)/.test(ctype)) {
    up.resume();
    throw new ApiError(502, 'NOT_MEDIA', 'The link returned a web page/JSON instead of a media file (it may have expired).');
  }
  const len = Number(up.headers['content-length']);
  if (opts.maxBytes > 0 && Number.isFinite(len) && len > opts.maxBytes) {
    up.resume();
    throw new ApiError(413, 'TOO_LARGE', 'File is larger than this server allows.');
  }

  const headers = { ...baseHeaders, 'content-disposition': contentDisposition(filename) };
  for (const h of PASS_HEADERS) if (up.headers[h]) headers[h] = up.headers[h];
  if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
  res.writeHead(status, headers);

  let sent = 0;
  up.on('data', (chunk) => {
    sent += chunk.length;
    if (opts.maxBytes > 0 && sent > opts.maxBytes) {
      finished = true;
      up.destroy();
      res.destroy(); // can't change status after headers; cut the connection
      return;
    }
    if (!res.write(chunk)) {
      up.pause();
      res.once('drain', () => up.resume());
    }
  });
  await new Promise((resolve) => {
    up.on('end', () => { finished = true; res.end(); resolve(); });
    up.on('error', () => { finished = true; res.destroy(); resolve(); });
    res.on('close', resolve);
  });
}

module.exports = { streamMedia, safeFilename };
