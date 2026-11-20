#!/usr/bin/env bash
set -euo pipefail
root=/opt/kodrosta-site-preview
web=kodrosta-intake-web-1
config=$(docker inspect "$web" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')
test -n "$config"
docker network inspect kodrosta-site-preview --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' | grep -qx "$web" || docker network connect kodrosta-site-preview "$web"
backup="$root/caddy-before-$(date +%s).conf"
cp -p "$config" "$backup"
if ! grep -q '^site-preview.codrosta.club {' "$config"; then
  cat >> "$config" <<'CADDY'

site-preview.codrosta.club {
    encode zstd gzip
    request_body {
        max_size 64KB
    }
    header X-Robots-Tag "noindex, nofollow, noarchive"
    header Referrer-Policy "no-referrer"
    reverse_proxy kodrosta-site-preview:8080
}
CADDY
fi
if ! docker exec "$web" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  cat "$backup" > "$config"
  printf 'Caddy validation failed; previous configuration restored\n' >&2
  exit 1
fi
docker exec "$web" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
printf 'Preview route enabled; original hosts retained\n'
