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
