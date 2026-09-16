#!/bin/bash
# Проверяет, что последний git push реально задеплоился на Cloudflare.
#
# Cloudflare Git-интеграция деплоит асинхронно: успешный `git push` ничего
# не говорит о том, прошла ли сборка (npx wrangler deploy) — при провале
# сборки прошлая (рабочая) версия Worker'а остаётся жить, и без явной
# проверки это легко не заметить (см. инцидент с @Kodrosta, сентябрь 2026 —
# сборка была сломана несколько дней незамеченно).
#
# Токен — в Keychain (security add-generic-password), НЕ в файлах репо:
#   -a "cloudflare-kodrosta" -s "cloudflare-kodrosta-api-token"
# Право токена: Workers Scripts (Read/Edit) на аккаунт
# fec59edf23c1f04af17abf63fffa8ec8.
#
# Использование: после каждого push с изменениями в .js/wrangler.jsonc —
#   bash scripts/check-deploy-status.sh
# Сравнить выведенное время последнего деплоя с моментом пуша: если оно
# новее пуша (с учётом ~30-60с на сборку) — задеплоилось; если старое —
# сборка не прошла, нужно смотреть на дашборде Cloudflare, что упало.

set -euo pipefail

ACCOUNT_ID="fec59edf23c1f04af17abf63fffa8ec8"
SCRIPT_NAME="kodrosta-site"

TOKEN=$(security find-generic-password -a "cloudflare-kodrosta" -s "cloudflare-kodrosta-api-token" -w)

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/deployments" \
  | python3 -c '
import json, sys
data = json.load(sys.stdin)
if not data.get("success"):
    print("Ошибка API:", data.get("errors"))
    sys.exit(1)
deployments = data["result"]["deployments"]
if not deployments:
    print("Нет ни одного деплоя вообще.")
    sys.exit(1)
latest = deployments[0]
print("Последний успешный деплой:", latest["created_on"])
print("id:", latest["id"])
'
