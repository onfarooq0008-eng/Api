# DLHub API

Self-hosted media-downloader REST API, built to be the backend of your Android app.
Fetches download links from TikTok, Instagram, YouTube, Facebook, X/Twitter, Spotify, SoundCloud,
Pinterest, Google Drive, MediaFire, CapCut, Douyin, Xiaohongshu, SnackVideo, Cocofun, Threads, Kuaishou
(+ YouTube search) through one consistent JSON format, and streams files through a safe download proxy.

* Node 20+, **no web framework** – only dependency is [`btch-downloader`](https://www.npmjs.com/package/btch-downloader)
* **No API key needed** (optional `X-API-Key` protection if you ever want it), rate limiting, response cache + request de-duplication
* SSRF-hardened file proxy with **Range/resume support** (works with Android DownloadManager / ExoPlayer)
* Docker, one-click VPS installer, Koyeb-ready
* `PROVIDER=mock` mode so you can build the app without hitting real platforms

## 1) One-click on your VPS

Upload this folder to the VPS (or push it to your own GitHub repo), then:

```bash
sudo bash install.sh                            # http://SERVER_IP:8000
sudo bash install.sh --domain api.example.com   # automatic HTTPS (point an A record at the VPS first)
```

It installs Docker if needed, builds and starts the container (auto-restarts on reboot)
and prints your **Base URL**. Later: `bash install.sh update | status | logs | key | uninstall` (inside `/opt/dlhub-api`).

Straight from GitHub, no upload:
```bash
curl -fsSL https://raw.githubusercontent.com/YOU/REPO/main/install.sh | \
  sudo REPO_URL=https://github.com/YOU/REPO.git bash -s -- --domain api.example.com
```

## 2) Deploy on Koyeb

1. Push this folder to a GitHub repo.
2. Koyeb dashboard → **Create Service → GitHub** → pick the repo → Builder: **Dockerfile**.
3. Exposed port **8000** (HTTP). Health check path: `/api/health`.
4. Environment variables: none required. Optional: `PUBLIC_URL` = `https://your-app.koyeb.app`.
5. Deploy. Base URL is `https://<app>-<org>.koyeb.app`.

Or with the CLI (check `koyeb app init --help` for your CLI version):
```bash
koyeb app init dlhub --git github.com/YOU/REPO --git-branch main --git-builder docker \
  --ports 8000:http --routes /:8000 --env TRUST_PROXY=1
```

## 3) Run locally

```bash
npm install
cp .env.example .env          # optional
npm start                     # real downloads
npm run dev:mock              # fake data, offline
npm test
```
Open `http://localhost:8000/` for the built-in tester page.

## API (what your Android app calls)

No key is needed. (Optional: set `API_KEYS` in `.env` and every `/api/*` call must send `X-API-Key`.)

| Route | Purpose |
|---|---|
| `GET /api/health` | liveness (`?deep=1` also probes the upstream scraper; 503 if broken) |
| `GET /api/platforms` | supported platforms, input type, example, `supportsLimit` |
| `GET /api/download/:platform?url=…` | get media info + links (`?query=` for `youtube-search`, `pinterest`; `?limit=1..50`; `?raw=1` adds raw upstream JSON) |
| `GET /api/fetch-media?url=…&filename=…` | stream a media URL as an attachment (Range supported) |

**Download response**
```json
{
  "success": true, "platform": "tiktok", "input": "https://…",
  "data": {
    "kind": "media",
    "title": "…", "thumbnail": "https://…", "author": null,
    "media": [
      { "label": "Video", "type": "video", "url": "https://cdn…/a.mp4",
        "downloadUrl": "https://YOUR_API/api/fetch-media?url=…&filename=….mp4" },
      { "label": "Audio", "type": "audio", "url": "…", "downloadUrl": "…" }
    ]
  }
}
```
Search platforms return `"kind": "list"` with `items[] {title,url,thumbnail,type,meta,downloadable,downloadUrl?}`.
`downloadable:false` (YouTube search) means “run this `url` through `/api/download/youtube` next”.

**Errors** – always `{"success":false,"error":{"code","message","status","requestId"}}`:
`400 MISSING_PARAM/BAD_URL/WRONG_PLATFORM`, `401 UNAUTHORIZED`, `404 UNKNOWN_PLATFORM`,
`429 RATE_LIMITED` (+`Retry-After`), `502 NO_MEDIA_FOUND/UPSTREAM_ERROR`, `504 UPSTREAM_TIMEOUT`.

**Android notes**: no headers needed. Use the `url` (direct CDN link) for streaming in ExoPlayer, `downloadUrl` for saving files.

## Configuration

See [`.env.example`](.env.example) – every setting is documented there.
Tip: set `FETCH_MEDIA_ALLOWED_HOSTS` to your platforms' CDN domains to lock the proxy down further.

## Notes

* Scraped links expire quickly – keep `CACHE_TTL_MS` short (default 5 min).
* `aio` and `mediafire` are flagged deprecated upstream; expect them to break first.
* Platforms change often; if one stops working, `npm update btch-downloader` (or `bash install.sh update`) is usually the fix.
* Only download content you have the right to download, and respect each platform's terms.
