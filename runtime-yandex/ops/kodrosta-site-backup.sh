#!/usr/bin/env bash
# Ежедневный логический бэкап kodrosta_site. Запускается systemd от root.
set -euo pipefail
umask 077

BACKUP_DIR=/secure/backups
ENV_FILE=/opt/kodrosta-site-prod/private/backup.env
CA_FILE=/etc/kodrosta/yandex-ca.pem
IMAGE=postgres:17-alpine
DOCKER=/usr/bin/docker

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="$BACKUP_DIR/kodrosta_site-$STAMP.dump"
cleanup() { rm -f "$OUT" "$OUT.sha256"; }
trap cleanup ERR

"$DOCKER" run --rm --network host --user 0 \
  -v "$CA_FILE":/ca.pem:ro \
  --env-file "$ENV_FILE" \
  --entrypoint sh "$IMAGE" \
  -c 'pg_dump "$DATABASE_URL" -Fc --no-owner --no-privileges' > "$OUT"
chmod 600 "$OUT"

"$DOCKER" run --rm --user 0 \
  -v "$OUT":/backup.dump:ro \
  --entrypoint pg_restore "$IMAGE" \
  --list /backup.dump >/dev/null

sha256sum "$OUT" > "$OUT.sha256"
chmod 600 "$OUT.sha256"

find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'kodrosta_site-*.dump' -o -name 'kodrosta_site-*.dump.sha256' \) \
  -mtime +14 -delete

SIZE="$(stat -c %s "$OUT")"
logger -t kodrosta-site-backup "ok $OUT ${SIZE}B"
echo "backup-ok $OUT ${SIZE}B"
