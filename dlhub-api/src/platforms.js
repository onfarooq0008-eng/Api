'use strict';

/**
 * Registry of supported platforms. Adding one = adding one entry here.
 *
 *  fn          function name exported by the `btch-downloader` package
 *  input       "url" | "query" | "url_or_query"
 *  defaultType media type assumed for untyped links ("video" | "audio" | "image" | "file")
 *  list        true when the result is a search list rather than a single item
 *  limit       true when the optional ?limit= parameter applies
 *  strict      true (default) -> an answer without links is an upstream failure (502)
 *  hosts       hostnames the URL must belong to (subdomains included); omitted = any
 */
const PLATFORMS = {
  tiktok: {
    fn: 'ttdl', input: 'url', defaultType: 'video',
    hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    example: 'https://www.tiktok.com/@user/video/1234567890',
  },
  instagram: {
    fn: 'igdl', input: 'url', defaultType: 'video',
    hosts: ['instagram.com', 'instagr.am'],
    example: 'https://www.instagram.com/reel/xxxxxxxxxxx/',
  },
  facebook: {
    fn: 'fbdown', input: 'url', defaultType: 'video',
    hosts: ['facebook.com', 'fb.watch', 'fb.com'],
    example: 'https://www.facebook.com/watch/?v=1234567890',
  },
  twitter: {
    fn: 'twitter', input: 'url', defaultType: 'video',
    hosts: ['twitter.com', 'x.com'],
    example: 'https://x.com/user/status/1234567890',
  },
  youtube: {
    fn: 'youtube', input: 'url', defaultType: 'video',
    hosts: ['youtube.com', 'youtu.be'],
    example: 'https://youtu.be/xxxxxxxxxxx',
  },
  'youtube-search': {
    fn: 'yts', input: 'query', list: true, limit: true,
    example: 'Somewhere Only We Know',
  },
  spotify: {
    fn: 'spotify', input: 'url', defaultType: 'audio', strict: false,
    hosts: ['spotify.com', 'spotify.link'],
    example: 'https://open.spotify.com/track/xxxxxxxxxxxxxxxxxxxxxx',
  },
  soundcloud: {
    fn: 'soundcloud', input: 'url', defaultType: 'audio',
    hosts: ['soundcloud.com', 'on.soundcloud.com'],
    example: 'https://soundcloud.com/artist/track-name',
  },
  pinterest: {
    fn: 'pinterest', input: 'url_or_query', defaultType: 'image', limit: true,
    example: 'https://pin.it/xxxxxxx  (or a search term)',
  },
  mediafire: {
    fn: 'mediafire', input: 'url', defaultType: 'file', deprecated: true,
    hosts: ['mediafire.com'],
    example: 'https://www.mediafire.com/file/xxxxxxxxxxx/name/file',
  },
  gdrive: {
    fn: 'gdrive', input: 'url', defaultType: 'file',
    hosts: ['drive.google.com', 'docs.google.com'],
    example: 'https://drive.google.com/file/d/xxxxxxxxxxx/view',
  },
  capcut: {
    fn: 'capcut', input: 'url', defaultType: 'video',
    hosts: ['capcut.com'],
    example: 'https://www.capcut.com/template-detail/xxxxxxxxxxx',
  },
  douyin: {
    fn: 'douyin', input: 'url', defaultType: 'video',
    hosts: ['douyin.com', 'iesdouyin.com'],
    example: 'https://v.douyin.com/xxxxxxx/',
  },
  xiaohongshu: {
    fn: 'xiaohongshu', input: 'url', defaultType: 'video', strict: false,
    hosts: ['xiaohongshu.com', 'xhslink.com'],
    example: 'https://xhslink.com/o/xxxxxxxxxxx',
  },
  'xiaohongshu-profile': {
    fn: 'xiaohongshuProfile', input: 'url', defaultType: 'image', strict: false,
    hosts: ['xiaohongshu.com', 'xhslink.com'],
    example: 'https://www.xiaohongshu.com/user/profile/xxxxxxxxxxxxxxxxxxxxxxxx',
  },
  snackvideo: {
    fn: 'snackvideo', input: 'url', defaultType: 'video', strict: false,
    hosts: ['snackvideo.com'],
    example: 'https://s.snackvideo.com/p/xxxxxxxx',
  },
  cocofun: {
    fn: 'cocofun', input: 'url', defaultType: 'video', strict: false,
    hosts: ['icocofun.com', 'cocofun.com'],
    example: 'https://www.icocofun.com/share/post/xxxxxxxxxxx',
  },
  threads: {
    fn: 'threads', input: 'url', defaultType: 'video', strict: false,
    hosts: ['threads.com', 'threads.net'],
    example: 'https://www.threads.com/@user/post/xxxxxxxxxxx',
  },
  kuaishou: {
    fn: 'kuaishou', input: 'url', defaultType: 'video', strict: false,
    hosts: ['kuaishou.com', 'chenzhongtech.com'],
    example: 'https://v.kuaishou.com/xxxxxxx',
  },
  // Auto-detects the platform from the URL. Deprecated upstream: first to break.
  aio: {
    fn: 'aio', input: 'url', defaultType: 'video', deprecated: true, strict: false,
    example: 'https://www.tiktok.com/@user/video/1234567890',
  },
};

/** True when `hostname` equals or is a subdomain of one of `hosts`. */
function hostMatches(hostname, hosts) {
  const h = String(hostname).toLowerCase();
  return hosts.some((d) => h === d || h.endsWith('.' + d));
}

module.exports = { PLATFORMS, hostMatches };
