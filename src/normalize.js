'use strict';

/**
 * Turns the very different raw shapes returned by btch-downloader into ONE
 * stable shape your Android app can rely on:
 *
 *   { kind: "media", title, thumbnail, author, media: [{ label, type, url }] }
 *   { kind: "list",  items: [{ title, url, thumbnail, type, meta, downloadable }] }
 *
 * Approach: a few exact handlers for list-style platforms, and one generic
 * scanner (walk the response, collect URLs, classify by extension / key name)
 * for everything else, steered by each platform's `defaultType`.
 */

const isUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v);
const EXT = {
  video: /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i,
  audio: /\.(mp3|m4a|aac|ogg|wav|opus|flac)(\?|#|$)/i,
  image: /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i,
};

function typeOf({ url = '', label = '', mime = '', fallback = 'file' }) {
  const m = String(mime).toLowerCase();
  for (const t of ['video', 'audio', 'image']) if (m.startsWith(t + '/')) return t;
  for (const t of ['video', 'audio', 'image']) if (EXT[t].test(url)) return t;
  const l = String(label).toLowerCase();
  if (/(video|mp4|reel|clip)/.test(l)) return 'video';
  if (/(audio|music|song|mp3|sound)/.test(l)) return 'audio';
  if (/(image|photo|cover|artwork|thumb|picture)/.test(l)) return 'image';
  return fallback;
}

// ---- key-name helpers (camelCase / snake_case split, plural "s" dropped) ----
const tokens = (key) =>
  String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
const THUMB = new Set(['thumb', 'thumbnail', 'cover', 'poster', 'preview', 'avatar', 'artwork', 'image', 'img', 'icon']);
const LINK = new Set(['download', 'video', 'audio', 'music', 'song', 'mp3', 'mp4', 'media', 'play', 'src', 'url', 'link', 'file', 'hd', 'sd', 'nowm', 'nwm', 'wm', 'normal']);
const SKIP = new Set(['developer', 'status', 'success', 'error', 'creator', 'message', 'code']);
const has = (set) => (key) => tokens(key).some((t) => set.has(t));
const isThumbKey = has(THUMB);
const isLinkKey = has(LINK);

const TITLE_KEYS = ['title', 'caption', 'desc', 'description', 'filename', 'name', 'text'];
const AUTHOR_KEYS = ['author', 'authorName', 'username', 'nickname', 'artist', 'artists', 'uploader', 'owner'];

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() && !isUrl(v.trim())) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
    if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim();
    if (v && typeof v === 'object' && typeof v.full_name === 'string' && v.full_name.trim()) return v.full_name.trim();
  }
  return null;
}

function prettyLabel(key, type) {
  const k = String(key || '').trim();
  if (!k || /^(url|link|src|file|media|download)$/i.test(k)) return type === 'file' ? 'File' : type[0].toUpperCase() + type.slice(1);
  if (/^(hd|sd|nowm|nwm|wm)$/i.test(k)) return k.toUpperCase();
  const spaced = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced[0].toUpperCase() + spaced.slice(1);
}

function scan(raw, { defaultType = 'file' } = {}) {
  const found = []; // { key, url, mime }
  let nodes = 0;
  (function walk(value, key, depth, parent) {
    if (nodes++ > 600 || depth > 7 || value == null) return;
    if (typeof value === 'string') {
      if (isUrl(value)) found.push({ key, url: value, mime: parent && (parent.mimetype || parent.mime || parent.type) });
    } else if (Array.isArray(value)) {
      value.forEach((v) => walk(v, key, depth + 1, parent));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) if (!SKIP.has(k)) walk(v, k, depth + 1, value);
    }
  })(raw, '', 0, null);

  const seen = new Set();
  const thumbs = [];
  let media = [];
  let thumbnail = null;

  for (const { key, url, mime } of found) {
    if (seen.has(url)) continue;
    seen.add(url);
    const t = typeOf({ url, label: key, mime, fallback: '' });
    if (isThumbKey(key) && t !== 'video' && t !== 'audio') {
      thumbnail = thumbnail || url;
      thumbs.push({ label: prettyLabel(key, 'image'), type: 'image', url });
      continue;
    }
    if (!t && !isLinkKey(key)) continue; // an unrelated URL (profile link, etc.)
    const type = t || defaultType;
    media.push({ label: prettyLabel(key, type), type, url });
  }
  if (!media.length) media = thumbs; // image-only posts: the "thumbnails" are the content

  // number duplicate labels: "Video", "Video" -> "Video 1", "Video 2"
  const counts = {};
  media.forEach((m) => (counts[m.label] = (counts[m.label] || 0) + 1));
  const idx = {};
  media.forEach((m) => {
    if (counts[m.label] > 1) m.label += ' ' + (idx[m.label] = (idx[m.label] || 0) + 1);
  });

  let title = null, author = null;
  const layers = [raw];
  for (const k of ['result', 'data']) if (raw && raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k])) layers.push(raw[k]);
  if (layers[1] && layers[1].data && typeof layers[1].data === 'object') layers.push(layers[1].data);
  for (const l of layers) {
    title = title || pickString(l, TITLE_KEYS);
    author = author || pickString(l, AUTHOR_KEYS);
  }
  return { kind: 'media', title, thumbnail, author, media };
}

// ---- exact handlers for list-style results ----
function youtubeSearch(raw) {
  const all = (raw && raw.result && Array.isArray(raw.result.all)) ? raw.result.all : [];
  return {
    kind: 'list',
    items: all.filter((it) => isUrl(it && it.url)).map((it) => ({
      title: it.title || it.name || null,
      url: it.url,
      thumbnail: it.thumbnail || it.image || null,
      type: it.type === 'list' ? 'playlist' : 'video',
      meta: it.type === 'list' ? (it.videoCount != null ? `${it.videoCount} videos` : null) : (it.timestamp || (it.duration && it.duration.timestamp) || null),
      downloadable: false, // a watch-page link: run it through /api/download/youtube next
    })),
  };
}

function pinterest(raw, opts) {
  const layer = raw && raw.result;
  if (!layer) return null;
  const search = layer.result;
  if (search && Array.isArray(search.result)) {
    return {
      kind: 'list',
      items: search.result.map((p) => {
        const video = isUrl(p.video_url);
        const url = video ? p.video_url : (p.images && p.images.original) || p.image_url;
        return {
          title: p.title || (p.description && String(p.description).trim()) || null,
          url,
          thumbnail: (p.images && (p.images.medium || p.images.large)) || p.image_url || null,
          type: video ? 'video' : 'image',
          meta: p.uploader ? p.uploader.full_name || null : null,
          downloadable: true,
        };
      }).filter((it) => isUrl(it.url)),
    };
  }
  return scan(layer.result && typeof layer.result === 'object' ? layer.result : layer, opts);
}

const HANDLERS = { 'youtube-search': youtubeSearch, pinterest };

/** @returns normalized object, or null when nothing usable was found */
function normalize(platformKey, platform, raw) {
  if (!raw || typeof raw !== 'object') return null;
  let out;
  try {
    out = (HANDLERS[platformKey] || scan)(raw, { defaultType: platform.defaultType });
  } catch {
    return null;
  }
  if (!out) return null;
  if (out.kind === 'media') {
    out.media = out.media.filter((m) => isUrl(m.url));
    if (!out.media.length) return null;
  } else {
    out.items = out.items.filter((i) => isUrl(i.url));
    if (!out.items.length) return null;
  }
  return out;
}

/** Trim list-shaped raw responses in place so `raw` and `data` agree. */
function truncate(platformKey, raw, limit) {
  if (!raw || typeof raw !== 'object') return raw;
  if (platformKey === 'youtube-search' && raw.result) {
    if (Array.isArray(raw.result.all)) raw.result.all = raw.result.all.slice(0, limit);
    if (Array.isArray(raw.result.videos)) raw.result.videos = raw.result.videos.slice(0, limit);
  } else if (platformKey === 'pinterest') {
    const s = raw.result && raw.result.result;
    if (s && Array.isArray(s.result)) {
      s.result = s.result.slice(0, limit);
      if (typeof s.count === 'number') s.count = Math.min(s.count, limit);
    }
  }
  return raw;
}

module.exports = { normalize, truncate, typeOf, isUrl };
