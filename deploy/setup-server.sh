#!/usr/bin/env bash
# Beat Earth — install or update on the server (Ubuntu, run as root). Safe to run again for every update.
#   curl -fsSL https://raw.githubusercontent.com/SultonbekovSarvarbek/beat-earth/main/deploy/setup-server.sh | bash
#
# What it does:
#   1. clones / updates the repo in /opt/beat-earth
#   2. builds the frontend (low-memory friendly) and publishes it to /var/www/beat-earth
#   3. installs nginx sites for beat-earth.happybox.uz and beat-earth-api.happybox.uz (only if missing)
#   4. gets Let's Encrypt certificates for both domains (only if missing)
set -euo pipefail

REPO_URL="https://github.com/SultonbekovSarvarbek/beat-earth.git"
SRC=/opt/beat-earth
WEB_ROOT=/var/www/beat-earth
FRONT=beat-earth.happybox.uz
API=beat-earth-api.happybox.uz

log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }

log "Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
command -v git >/dev/null || apt-get install -y git
command -v rsync >/dev/null || apt-get install -y rsync

log "Source → $SRC"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin main
  git -C "$SRC" reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$SRC"
fi
git -C "$SRC" log --oneline -1

log "Build frontend"
cd "$SRC/web"
export NODE_OPTIONS="--max-old-space-size=1536"
npm ci --no-audit --no-fund
npm run build

log "Publish → $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete dist/ "$WEB_ROOT/"

log "nginx sites"
for pair in "$FRONT:nginx-front.conf" "$API:nginx-api.conf"; do
  host="${pair%%:*}"; conf="${pair##*:}"
  if [ ! -e "/etc/nginx/sites-available/$host" ]; then
    cp "$SRC/deploy/$conf" "/etc/nginx/sites-available/$host"
    echo "installed $host"
  else
    echo "$host already configured — left as is (compare with $SRC/deploy/$conf)"
  fi
  ln -sf "/etc/nginx/sites-available/$host" "/etc/nginx/sites-enabled/$host"
done
nginx -t
systemctl reload nginx

log "HTTPS certificates"
need=()
for host in "$FRONT" "$API"; do
  [ -d "/etc/letsencrypt/live/$host" ] || need+=(-d "$host")
done
if [ ${#need[@]} -gt 0 ]; then
  certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect "${need[@]}" \
    || echo "!! certbot failed — check that both DNS names point to this server, then run the script again"
else
  echo "certificates already present"
fi
nginx -t && systemctl reload nginx

log "Checks"
KEY=$(grep '^VITE_SUPABASE_ANON_KEY=' "$SRC/web/.env.production" | cut -d= -f2-)
printf 'front: '; curl -s -o /dev/null -w '%{http_code}\n' --resolve "$FRONT:443:127.0.0.1" "https://$FRONT/" || true
printf 'api:   '; curl -s --resolve "$API:443:127.0.0.1" "https://$API/auth/v1/health" -H "apikey: $KEY" || true
echo
log "Done: https://$FRONT"
