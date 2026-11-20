#!/usr/bin/env bash
# Проверка production-сайта после cutover. Запускается systemd от root.
set -euo pipefail
umask 077

BASE_URL="${BASE_URL:-https://codrosta.club}"
APP_ENV=/opt/kodrosta-site-prod/private/app.env
STATE=/run/kodrosta-site-health.last-alert
ALERT_INTERVAL=${ALERT_INTERVAL:-900}

fail=0
check() {
  if ! curl -fsS --max-time 10 "$1" >/dev/null; then
    fail=1
    logger -t kodrosta-site-health "check failed: $1"
  fi
}

check "$BASE_URL/health/ready"
check "$BASE_URL/"
check "$BASE_URL/api/events"

if [ "$fail" -eq 0 ]; then
  rm -f "$STATE"
  exit 0
fi

now="$(date +%s)"
last="$(cat "$STATE" 2>/dev/null || echo 0)"
if [ $((now - last)) -lt "$ALERT_INTERVAL" ]; then
  exit 1
fi
printf '%s\n' "$now" > "$STATE"

if [ -r "$APP_ENV" ]; then
  BOT_TOKEN="$(grep '^BOT_TOKEN=' "$APP_ENV" | cut -d= -f2- || true)"
  CHAT_ID="$(grep '^CHAT_ID=' "$APP_ENV" | cut -d= -f2- || true)"
  if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    curl -fsS --max-time 10 -X POST \
      "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=Код Роста: сайт не отвечает. Проверь /health/ready, главную и API." \
      >/dev/null || logger -t kodrosta-site-health "telegram alert failed"
  fi
fi

logger -t kodrosta-site-health "site unhealthy"
exit 1
