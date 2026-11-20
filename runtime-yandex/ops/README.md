# Бэкапы kodrosta_site

Ежедневный логический `pg_dump` в `/secure/backups` на российской ВМ.

Установка (после появления production-приложения):

```bash
sudo install -m 700 runtime-yandex/ops/kodrosta-site-backup.sh /usr/local/sbin/kodrosta-site-backup.sh
sudo install -m 644 runtime-yandex/ops/kodrosta-site-backup.service /etc/systemd/system/kodrosta-site-backup.service
sudo install -m 644 runtime-yandex/ops/kodrosta-site-backup.timer /etc/systemd/system/kodrosta-site-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now kodrosta-site-backup.timer
sudo systemctl start kodrosta-site-backup.service
sudo systemctl status kodrosta-site-backup.service
```

Нужен `/opt/kodrosta-site-prod/private/backup.env` с `DATABASE_URL` роли
`site_migrations` (права 600) и CA `/etc/kodrosta/yandex-ca.pem`.
Хранятся 14 дней; managed-бэкапы кластера — отдельно, 14 дней.

## Мониторинг после cutover

`kodrosta-site-health` проверяет `/health/ready`, `/` и `/api/events` каждые
2 минуты; при сбое пишет в journal и отправляет сообщение в `CHAT_ID` через
`BOT_TOKEN` из `/opt/kodrosta-site-prod/private/app.env`. Повторный алерт не
чаще раза в 15 минут.

```bash
sudo install -m 700 runtime-yandex/ops/kodrosta-site-health.sh /usr/local/sbin/kodrosta-site-health.sh
sudo install -m 644 runtime-yandex/ops/kodrosta-site-health.service /etc/systemd/system/kodrosta-site-health.service
sudo install -m 644 runtime-yandex/ops/kodrosta-site-health.timer /etc/systemd/system/kodrosta-site-health.timer
sudo systemctl daemon-reload
sudo systemctl enable --now kodrosta-site-health.timer
```

Включать только после переключения DNS: до cutover основной домен обслуживает
Cloudflare и проверка будет давать ложные сбои.

## Caddy на cutover

`Caddyfile.codrosta-block` — готовый блок `codrosta.club` + `www` на
`kodrosta-site-prod:8080`. Добавлять только после A-записи на ВМ. Caddyfile
смонтирован read-only: писать в тот же inode через `tee`, затем
`caddy validate` и `caddy reload` (или перезапуск Caddy). После проверки
сертификата и страниц включать health-check timer и планировщик приложения.

## Production app

С Yandex Cloud `api.telegram.org` по умолчанию резолвится в
`149.154.166.110`, который не отвечает. Рабочий IP — `149.154.167.220`.
Для контейнера нужен `--add-host`; для процессов на хосте — запись в
`/etc/hosts`. Node собирается с `--dns-result-order=ipv4first`.

```bash
sudo docker network inspect kodrosta-site-prod >/dev/null 2>&1 || sudo docker network create kodrosta-site-prod
sudo docker run -d --name kodrosta-site-prod --restart unless-stopped \
  --network kodrosta-site-prod --memory=256m --cpus=.5 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --add-host api.telegram.org:149.154.167.220 \
  -v /etc/kodrosta/yandex-ca.pem:/ca.pem:ro \
  --env-file /opt/kodrosta-site-prod/private/app.env \
  kodrosta-site-prod:2026-11-20
sudo docker network connect kodrosta-site-prod kodrosta-intake-web-1
```

`DISABLE_SCHEDULER=1` в env до cutover; после отключения старого cron —
убрать/поставить 0 и перезапустить контейнер. Вебхук переключать только
вместе с DNS: `setWebhook` на `https://codrosta.club/api/telegram-webhook`
с `secret_token` из `TELEGRAM_WEBHOOK_SECRET`.



