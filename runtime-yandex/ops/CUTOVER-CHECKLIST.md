# Cutover checklist — codrosta.club

Состояние на 21 ноября 2026. Production переключён на Yandex Cloud; старый Worker/D1 оставлены на наблюдение.

## Готово

- [x] Код активной версии Worker сверен с preview; статика совпадает.
- [x] БД `kodrosta_site` и роли `site_migrations`/`site_app`; 21 миграция.
- [x] D1 → PostgreSQL: 22 таблицы, 7 640 строк; QR/оплаты/проходы сверены.
- [x] Production-образ; Caddy-проверка; формы с реальным ботом — 200.
- [x] Токен @KodrostaAssistant_bot в `app.env`; webhook secret_token.
- [x] Бэкапы: ежедневный timer + проверенное восстановление.
- [x] Health-check и Caddy-блок подготовлены.
- [x] DNS-токен Cloudflare с DNS Write проверен созданием/удалением TXT.
- [x] Staging `prod-test.codrosta.club` на реальной БД и боте: HTTPS Let's Encrypt, страницы и форма — 200; Михаил подтвердил открытие в браузере.
- [x] D1 export перепроверен 21 ноября: 2 153 229 байт, sha256 совпал с дампом 22:17, новых строк нет; API работает при немедленном polling.
- [x] Cutover выполнен 21 ноября: A `codrosta.club`/`www` на ВМ, финальный импорт 7 640 строк, форма 200, webhook и расписания включены. Staging удалён.

## Важные ограничения

- С Yandex Cloud `api.telegram.org` по умолчанию идёт на недоступный
  `149.154.166.110`; рабочий IP `149.154.167.220`. Контейнеру нужен
  `--add-host api.telegram.org:149.154.167.220`, Node — `ipv4first`.
- Текущий webhook бота: `https://kodrosta-site.kyznetcov-m.workers.dev/api/telegram-webhook`.
  Пока он там, старый Worker продолжает получать команды бота и писать в D1,
  даже если снять custom domain.
- Caddyfile смонтирован read-only; `sed -i` меняет inode и не виден
  контейнеру. Писать через `tee` в тот же файл или перезапускать Caddy.
- DNS-токен лежит в `~/cloudflare-dns-token.txt` (600); после cutover отозвать.
- Staging `prod-test` закрыт `noindex`; после cutover убрать A-запись, Caddy-блок и контейнер.

## Окно

После 27 ноября, ночью/в низкий трафик. Ожидаемый простой 10–20 минут:
финальный экспорт/импорт и выпуск сертификата. Предупредить менеджеров.

## До окна

1. Проверить баланс Yandex Cloud и автоплатёж.
2. Сделать свежий `pg_dump` и D1-дамп; проверить размер.
3. Убедиться, что `app.env` содержит реальный `BOT_TOKEN`, `CHAT_ID`,
   `TELEGRAM_WEBHOOK_SECRET`; `DISABLE_SCHEDULER=1`.
4. Проверить, что `kodrosta-site-backup.timer` active.
5. Убедиться, что DNS-токен на месте и Caddy-блок staging не конфликтует
   с основным доменом.

## Cutover

1. **Заморозить старую площадку.**
   - `deleteWebhook` для @KodrostaAssistant_bot (не удалять pending updates).
   - Снять custom domain `codrosta.club`/`www` с Worker `kodrosta-site`.
   - Удалить cron-триггеры Worker.
   - Убедиться, что старая D1 больше не пишется.
2. **Финальный D1 export**: POST `{"output_format":"polling"}`, взять
   `at_bookmark`, сразу поллить тот же endpoint с `current_bookmark` до
   `result.result.signed_url`, скачать на ВМ. Один POST без повторного старта,
   иначе job отменяется; файл на Mac не создавать.
3. **Импорт:** `TRUNCATE` 22 таблиц `kodrosta_site`, импорт дампа, проверка
   количества/сумм и QR-токенов. Сверка обязательна.
4. **Caddy:** добавить блок `Caddyfile.codrosta-block` в тот же inode,
   `caddy validate`, `caddy reload`/restart. Стартовать контейнер
   `kodrosta-site-prod` с `--add-host` и `app.env`; подключить Caddy к сети.
5. **DNS:** A `@` и `www` → `130.193.58.254`, Proxy **DNS only**, TTL 300.
6. Дождаться сертификата; проверить `https://codrosta.club/health/ready`,
   главную, `/api/events`, `/api/content`, `/premiya`, `/admission`,
   `/calendar.ics`, `/itpark`; проверить с российского мобильного без VPN.
7. **Telegram:** `setWebhook` на `https://codrosta.club/api/telegram-webhook`
   с `secret_token` из `TELEGRAM_WEBHOOK_SECRET`. Проверить `getWebhookInfo`.
8. **Расписания:** убрать `DISABLE_SCHEDULER=1`, перезапустить app; включить
   health-check timer. Убедиться, что старый cron удалён.
9. **Формы/билеты:** тестовая заявка с пометкой «ТЕСТ», проверка билета,
   QR и вебхука; тестовые записи удалить.
10. **Наблюдение:** 2–4 недели. Worker/D1/custom domain не удалять.

## Rollback

- Вернуть custom domain/route Worker, A-запись на Cloudflare, webhook на
  dev-домен, cron Worker.
- Остановить app/cron, вернуть прежний Caddyfile.
- Записи, созданные на новом сайте после cutover, в старую D1 не попадут:
  перечислить и перенести вручную или согласовать.
- После rollback — сверка и разбор; не дожимать в том же окне.

## После наблюдения

- Отключить Worker/D1/custom domain; сохранить бэкапы.
- Решить вопрос NS: оставить Cloudflare DNS или перенести на Yandex DNS.
- Обновить политику конфиденциальности под российский хостинг.
