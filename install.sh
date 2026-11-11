#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  DLHub API - one-click installer for a fresh VPS (Ubuntu/Debian/CentOS/...)
#
#  Usage (run as root, from the project folder):
#     sudo bash install.sh                          # HTTP on port 8000
#     sudo bash install.sh --domain api.example.com # automatic HTTPS (DNS A record must point here)
#     sudo bash install.sh --port 3000
#     sudo bash install.sh --api-key MYKEY          # optional: require a key
#
#  Other commands:   update | status | logs | key | uninstall
#
#  Straight from your own GitHub repo (no upload needed):
#     curl -fsSL https://raw.githubusercontent.com/YOU/REPO/main/install.sh | \
#       sudo REPO_URL=https://github.com/YOU/REPO.git bash -s -- --domain api.example.com
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dlhub-api}"
REPO_URL="${REPO_URL:-}"
DOMAIN="${DOMAIN:-}"
HOST_PORT="${HOST_PORT:-8000}"
API_KEY_ARG="${API_KEY:-}"

CMD="install"
case "${1:-}" in install|update|status|logs|key|uninstall) CMD="$1"; shift;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)  DOMAIN="$2"; shift 2;;
    --port)    HOST_PORT="$2"; shift 2;;
    --api-key) API_KEY_ARG="$2"; shift 2;;
    --dir)     APP_DIR="$2"; shift 2;;
    --repo)    REPO_URL="$2"; shift 2;;
    -h|--help) sed -n '2,16p' "$0"; exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

c_ok="\033[32m"; c_err="\033[31m"; c_dim="\033[2m"; c_off="\033[0m"
say()  { printf "${c_ok}==>${c_off} %s\n" "$*"; }
die()  { printf "${c_err}ERROR:${c_off} %s\n" "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run as root:  sudo bash install.sh"

# --- locate / fetch the project -------------------------------------------
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SRC" ] && [ -f "$SRC/package.json" ] && [ -d "$SRC/src" ]; then
  if [ "$SRC" != "$APP_DIR" ] && [ "$CMD" = "install" ]; then
    say "Copying project to $APP_DIR"
    mkdir -p "$APP_DIR"
    cp -a "$SRC"/. "$APP_DIR"/
  elif [ "$SRC" = "$APP_DIR" ]; then :; fi
elif [ "$CMD" = "install" ]; then
  [ -n "$REPO_URL" ] || die "Run this from the project folder, or pass --repo/REPO_URL."
  command -v git >/dev/null 2>&1 || { say "Installing git"; (apt-get update -y && apt-get install -y git) >/dev/null 2>&1 || yum install -y git >/dev/null 2>&1 || die "Install git first."; }
  if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO_URL" "$APP_DIR"; fi
fi
[ -d "$APP_DIR" ] || die "$APP_DIR not found. Run 'install' first."
cd "$APP_DIR"

compose() {
  if [ -f Caddyfile ] && [ -n "$(grep -s '^DOMAIN=' .env | cut -d= -f2-)" ]; then
    docker compose --profile https "$@"
  else
    docker compose "$@"
  fi
}
env_get() { grep -s "^$1=" .env | head -1 | cut -d= -f2-; }
env_set() {
  if grep -qs "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

case "$CMD" in
status)    compose ps; exit 0;;
logs)      compose logs -f --tail=100 api; exit 0;;
key)       echo "API key(s): ${API_KEYS_SHOW:-$(env_get API_KEYS)} (empty = no key needed)"; exit 0;;
uninstall)
  read -r -p "Stop and remove DLHub API containers (files in $APP_DIR are kept)? [y/N] " a
  [ "$a" = "y" ] && compose down -v && say "Removed." ; exit 0;;
update)
  if [ -d .git ]; then git pull --ff-only; fi
  compose up -d --build; say "Updated."; exit 0;;
esac

# --- Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (official script)"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "'docker compose' plugin missing. Install docker-compose-plugin and re-run."

# --- .env (created once, never overwritten) -------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env"
fi
if [ -n "$API_KEY_ARG" ]; then
  env_set API_KEYS "$API_KEY_ARG"
fi
env_set TRUST_PROXY 1

# --- networking: plain HTTP or HTTPS via Caddy -----------------------------
if [ -n "$DOMAIN" ]; then
  printf '%s {\n\tencode zstd gzip\n\treverse_proxy api:8000 {\n\t\tflush_interval -1\n\t}\n}\n' "$DOMAIN" > Caddyfile
  env_set DOMAIN "$DOMAIN"
  env_set PUBLIC_URL "https://$DOMAIN"
  env_set BIND_ADDR 127.0.0.1
  env_set HOST_PORT 8000
else
  env_set BIND_ADDR 0.0.0.0
  env_set HOST_PORT "$HOST_PORT"
fi

# docker compose reads BIND_ADDR/HOST_PORT from .env as well
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [ -n "$DOMAIN" ]; then ufw allow 80,443/tcp >/dev/null; else ufw allow "$HOST_PORT"/tcp >/dev/null; fi
  say "Opened firewall port(s) in ufw"
fi

# --- build & run ----------------------------------------------------------
say "Building and starting (first build takes a minute)..."
compose up -d --build

say "Waiting for the API to become healthy..."
ok=0
for _ in $(seq 1 40); do
  if docker exec dlhub-api node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { docker logs --tail 40 dlhub-api; die "API did not start. See logs above."; }

IP="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$IP:$HOST_PORT"; fi
printf "\n${c_ok}DLHub API is running.${c_off}\n"
echo   "  Base URL : $URL"
if [ -n "$(env_get API_KEYS)" ]; then
  echo "  API key  : $(env_get API_KEYS)  (send as X-API-Key header)"
  echo "  Test     : curl -H 'X-API-Key: $(env_get API_KEYS)' '$URL/api/platforms'"
else
  echo "  Auth     : none (open API, no key needed)"
  echo "  Test     : curl '$URL/api/platforms'"
fi
echo   "  Web test : $URL/"
printf "${c_dim}  Manage   : bash install.sh status|logs|key|update|uninstall  (in $APP_DIR)${c_off}\n"
[ -n "$DOMAIN" ] && printf "${c_dim}  HTTPS needs a DNS A record: $DOMAIN -> $IP (certificate is issued on first request).${c_off}\n"
exit 0
