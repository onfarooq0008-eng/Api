'use strict';

/**
 * Provider = the thing that actually fetches download links.
 * Interface:  init() -> Promise,  has(fnName) -> bool,  call(fnName, input) -> Promise<raw>
 *
 *  - "btch": the real `btch-downloader` npm package
 *  - "mock": deterministic fake data, so you can build/test your Android app offline
 */

async function createBtchProvider() {
  let lib = null;
  let loadError = null;
  return {
    name: 'btch',
    async init() {
      try {
        const mod = await import('btch-downloader'); // works for both CJS and ESM builds
        lib = { ...mod, ...(mod.default && typeof mod.default === 'object' ? mod.default : {}) };
      } catch (e) {
        loadError = e;
        console.error('[provider] could not load "btch-downloader":', e.message);
      }
    },
    has: (fn) => Boolean(lib && typeof lib[fn] === 'function'),
    call: (fn, input) => lib[fn](input),
    get error() { return loadError; },
  };
}

function createMockProvider() {
  const IMG = 'https://picsum.photos/seed/dlhub/480/270';
  const VID = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';
  const AUD = 'https://samplelib.com/lib/preview/mp3/sample-3s.mp3';
  const fns = {
    ttdl: () => ({ title: 'Mock TikTok video', thumbnail: IMG, video: [VID], audio: [AUD] }),
    youtube: () => ({ status: true, title: 'Mock YouTube video', thumbnail: IMG, author: 'Mock Channel', mp4: VID, mp3: AUD }),
    yts: (q) => ({ status: true, result: { all: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ type: 'video', title: `${q} #${i}`, url: `https://www.youtube.com/watch?v=mock${String(i).padStart(7, '0')}`, thumbnail: IMG, timestamp: '3:21' })) } }),
    twitter: () => ({ title: 'Mock tweet', url: [{ hd: VID }, { sd: VID }] }),
    fbdown: () => ({ Normal_video: VID, HD: VID }),
    soundcloud: () => ({ result: { title: 'Mock track', thumbnail: IMG, downloadMp3: AUD } }),
    pinterest: (q) => (/^https?:/.test(q)
      ? { result: { result: { title: 'Mock pin', images: { orig: { url: IMG } }, user: { full_name: 'Mock User' } } } }
      : { result: { result: { count: 8, result: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ title: `${q} pin ${i}`, image_url: IMG, images: { original: IMG, medium: IMG } })) } } }),
    gdrive: () => ({ result: { data: { filename: 'mock.mp4', downloadUrl: VID } } }),
    mediafire: () => ({ result: { filename: 'mock.mp4', mimetype: 'video/mp4', url: VID, owner: 'mock' } }),
    capcut: () => ({ title: 'Mock template', originalVideoUrl: VID, coverUrl: IMG, authorName: 'Mock' }),
    douyin: () => ({ result: { data: { title: 'Mock douyin', thumbnail: IMG, links: [{ quality: '720p', url: VID }] } } }),
  };
  const generic = () => ({ result: [{ thumbnail: IMG, url: VID }] });
  return {
    name: 'mock',
    async init() {},
    has: () => true,
    call: async (fn, input) => (fns[fn] || generic)(input),
  };
}

async function createProvider(cfg) {
  const p = cfg.provider === 'mock' ? createMockProvider() : await createBtchProvider();
  await p.init();
  return p;
}

module.exports = { createProvider, createMockProvider };
