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


