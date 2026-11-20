#!/usr/bin/env bash
set -euo pipefail
release="$1"
root=/opt/kodrosta-site-preview
install -d -m 755 "$root/releases/$release"
install -d -m 700 "$root/private"
tar -xzf /tmp/kodrosta-site-preview.tar.gz -C "$root/releases/$release"
if [ ! -f "$root/private/postgres.env" ]; then
  umask 077
  password=$(openssl rand -hex 24)
  printf 'POSTGRES_USER=site_preview\nPOSTGRES_DB=site_preview\nPOSTGRES_PASSWORD=%s\n' "$password" > "$root/private/postgres.env"
  printf 'DATABASE_URL=postgresql://site_preview:%s@kodrosta-site-preview-db:5432/site_preview\nPREVIEW_MODE=1\nPUBLIC_ORIGIN=https://site-preview.codrosta.club\n' "$password" > "$root/private/app.env"
fi
docker network inspect kodrosta-site-preview >/dev/null 2>&1 || docker network create --internal kodrosta-site-preview >/dev/null
docker volume inspect kodrosta-site-preview-pg >/dev/null 2>&1 || docker volume create kodrosta-site-preview-pg >/dev/null
if ! docker inspect kodrosta-site-preview-db >/dev/null 2>&1; then
  docker run -d --name kodrosta-site-preview-db --restart unless-stopped --network kodrosta-site-preview \
    --memory=192m --cpus=.5 --env-file "$root/private/postgres.env" \
    -v kodrosta-site-preview-pg:/var/lib/postgresql/data postgres:17-alpine \
    -c shared_buffers=32MB -c max_connections=15 -c effective_cache_size=64MB >/dev/null
fi
for attempt in $(seq 1 20); do
  if docker exec kodrosta-site-preview-db pg_isready -U site_preview -d site_preview >/dev/null; then break; fi
  sleep 1
done
docker build -q -t "kodrosta-site-preview:$release" -f "$root/releases/$release/runtime-yandex/Dockerfile" "$root/releases/$release" > "$root/build-image.txt"
if docker inspect kodrosta-site-preview >/dev/null 2>&1; then
  # Только контейнер этого тестового проекта. Данные остаются в отдельном томе.
  docker rm -f kodrosta-site-preview >/dev/null
fi
docker run -d --name kodrosta-site-preview --restart unless-stopped --network kodrosta-site-preview \
  --memory=256m --cpus=.5 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL \
  --security-opt no-new-privileges:true --env-file "$root/private/app.env" \
  -e "RELEASE_SHA=$release" -e NODE_OPTIONS=--max-old-space-size=160 "kodrosta-site-preview:$release" >/dev/null
printf 'Preview containers started: %s\n' "$release"
