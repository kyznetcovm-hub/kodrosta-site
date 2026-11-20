# Отчёт о переносе codrosta.club на Yandex Cloud

Дата: 21 ноября 2026. Статус: **cutover выполнен**, идёт согласованный период наблюдения. Отчёт для независимой проверки. Секреты, пароли, ключи, QR-токены и персональные данные не включены.

## Кратко: сделано / проверено / осталось

**Сделано.** Основной сайт, премия, допуск/билеты, ERP и анкета обслуживаются с Yandex Cloud; DNS-зона осталась в Cloudflare, но A-записи переведены на ВМ без проксирования. PostgreSQL `kodrosta_site` с 22 таблицами и 7 640 строками; форма, Telegram-вебхук, планировщик, health-check и бэкапы работают. Старый Worker/D1 сохранены для отката, старый сайт отключён.

**Проверено.** DNS/A/NS, HTTPS и страницы; независимая от Cloudflare раздача; импорт и сверка данных; форма с реальным ботом; планировщик; health/backup timers; публичный путь вебхука; локальные интеграционные тесты (53 из 53, QR исправлен); demo-API 404 и удаление demo-панелей из production; ERP/анкета фактически на PostgreSQL `kodrosta`; финальный дамп восстановлен в dryrun; rollback-сценарий проверен в отдельной SQLite; исходники/образ/бэкапы.

**Осталось / не проверено.** Production-тест билетов через реальную Telegram-авторизацию не выполнен: синтетический вход не использовался; нужен вход владельца/сотрудника в Mini App. Реальные билеты не расходовались. QR round-trip локально исправлен и проходит (53/53); реальный QR из приглашения ждёт тестового билета/телефона. Google Sheet-синхронизация восстановлена 21.11: ключ сервисного аккаунта `kodrosta-sheets-reader@kodrosta-bot.iam.gserviceaccount.com` загружен в Lockbox и production env; `syncResidentsFromSheet` прочитал 295 строк, 0 новых/0 обновлений/0 дат; ошибок нет. Точный месячный расход Yandex не снят. Финальный дамп полностью восстановлен в dryrun, rollback-сценарий проверен в отдельной SQLite. ERP/анкета фактически используют PostgreSQL `kodrosta`, отчёт исправлен.

## 1. Адреса и DNS

| Адрес | Что обслуживает | IP | Где приложение | DNS | Cloudflare proxy | HTTP |
|---|---|---|---|---|---|---|
| `codrosta.club` | основной сайт, `/premiya`, `/admission`, блог, политика | 130.193.58.254 | Yandex VM, Caddy → `kodrosta-site-prod:8080` | A, DNS only | нет | 200 |
| `www.codrosta.club` | редирект на основной | 130.193.58.254 | Caddy | A, DNS only | нет | 301 → `https://codrosta.club/` |
| `erp.codrosta.club` | ERP | 130.193.58.254 | Yandex VM, Caddy → `registry:8080` | A, DNS only | нет | 200 |
| `anketa.codrosta.club` | анкета/интейк | 130.193.58.254 | Yandex VM, Caddy → `intake:8080` | A, DNS only | нет | 200 |
| `site-preview.codrosta.club` | изолированный preview, не production | 130.193.58.254 | Yandex VM, preview app | A, DNS only | нет | 200, noindex |

- NS зоны: `karl.ns.cloudflare.com`, `venus.ns.cloudflare.com`. Зона `codrosta.club` активна в Cloudflare; A-записи `proxied=false`.
- Веб-трафик страниц **не проходит через Cloudflare**: ответы приходят с IP 130.193.58.254, заголовок `Via: 1.1 Caddy`, `cf-ray` отсутствует. Cloudflare используется как DNS-провайдер.
- Проверка с российской ВМ (Yandex Cloud): все адреса выше отвечают; `www` — 301; сертификат Let's Encrypt. Михаил сообщил, что открыл основной сайт с телефона и он работает; отдельного замера с нескольких российских ISP без VPN не делалось — **не проверено**.
- **ERP/анкета (проверено 21.11):** страницы/API отдаются контейнерами `kodrosta-intake-registry-1` и `kodrosta-intake-intake-1` на Yandex VM. Оба `DATABASE_URL` указывают на Managed PostgreSQL `kodrosta-residents`, DB `kodrosta`, users `intake_registry`/`intake_app`. Фактические таблицы: `consent_documents`, `intake_audit`, `intake_migrations`, `intake_rate_limits`, `legacy_import_runs`, `legacy_sheet_rows`, `resident_applications`. Старые `erp_*` в D1 и Worker `kodrosta-erp` текущими ERP/анкетой не используются; удалять их без отдельного решения нельзя.

## 2. Код

| Параметр | Значение |
|---|---|
| Репозиторий | `https://github.com/kyznetcovm-hub/kodrosta-site` |
| Ветка | `codex/yandex-site-preview` |
| HEAD ветки | `8a47a0d` (QR-тест; приложение — `ba21f32`) |
| Код приложения в образе | `ba21f32` (включает 95f8107; PostgreSQL runtime DDL no-op и удаление demo-панелей) |
| Образ | `kodrosta-site-prod:2026-11-20`, image id `sha256:fc64e69fdc3b4d3c616dff094c926a4507574966843aa477253ac58e315a235b`, собран 21.11.2026 00:59 MSK |
| Контейнер | `kodrosta-site-prod`, host network |
| Код внутри образа | `/app` (`/app/src`, `/app/runtime-yandex`, `/app/migrations`, `/app/public-production`) |
| Конфиг на ВМ | `/opt/kodrosta-site-prod/private/app.env` (600; значения не приводятся) |
| Caddy | `/opt/kodrosta/d717f4b34864cac915735ad989900928eb1752ed/infra/Caddyfile` |
| Российская копия исходников | `/secure/kodrosta-site-branch.bundle` — 18 909 779 байт, sha256 `4aadd8cb18c4532b75f2f2545117a9a5db1797724f3d1503478d3d1d35111098`; `/secure/kodrosta-site-source.tar.gz` — 14 877 069 байт, 235 файлов, sha256 `3ee7a8b55bdd2c4401211aca5e468190e6546d19310e392681242a6e62608eb5` |
| Образ на ВМ | тот же image id; исходники также внутри образа |

GitHub — внешний хостинг; отдельная российская Git-площадка (SourceCraft) **не настроена**. Российская копия исходников есть в виде bundle и tar.gz на ВМ, плюс образ. SHA-256 ключевых файлов в контейнере: `server-production.mjs` — `a403b466…`, `postgres.mjs` — `850409ba…`, `src/index.js` — `67a94fda…`.

## 3. Рабочие данные

Источник: Cloudflare D1 `kodrosta-engagement` (база `6edb94c1-238e-4643-9300-36f51a463c57`). Цель: Yandex Managed PostgreSQL `kodrosta_site` (кластер `kodrosta-residents`, `c9qgb6msl9a3l3piv3k8`). Перенесены 22 таблицы сайта; `_cf_KV` и `erp_*` не переносились.

### Сверка количества записей

| Таблица | D1 до импорта | PostgreSQL после | Комментарий |
|---|---:|---:|---|
| residents | 298 | 298 | |
| admission_tickets | 3 | 3 | id — текстовые sheet-идентификаторы |
| admission_sheet_tickets | 3 | 3 | |
| admission_requests | 0 | 0 | |
| admission_staff | 0 | 0 | |
| admission_ticket_details | 0 | 0 | |
| touches | 6 154 | 6 154 | |
| events | 35 | 35 | |
| event_signups | 201 | 201 | |
| event_reminders | 164 | 164 | |
| content_fields | 48 | 48 | |
| cron_runs | 286 | 287 | +1 после запуска планировщика, не потеря |
| subscription_deliveries | 54 | 54 | |
| sales | 50 | 50 | |
| expenses | 19 | 19 | |
| raffles | 17 | 17 | |
| tg_groups | 8 | 8 | |
| tg_group_members | 227 | 227 | |
| pending_edits | 50 | 50 | |
| money_entry_edits | 5 | 5 | |
| sales_plans | 9 | 9 | |
| sales_plan_items | 9 | 9 | |
| **Итого** | **7 640** | **7 640** | строки сайта; `cron_runs` — операционная |

### Идентификаторы, QR, оплаты, проходы

- Импорт вставлял явные `id`; импортёр сбросил 9 identity-последовательностей через `setval(max+1, false)`. `touches` следующее значение 6278, `cron_runs` — 287; остальные последовательности выставлены на max+1 и ещё не вызывались. Коллизий при тестовых вставках не было.
- QR: `admission_tickets` — 3 записи, 3 различных токена, все длиной 64 символа, статус `active` у всех, один `checked_in_at` заполнен. Агрегатный MD5 набора токенов (без раскрытия значений): `b51d2d8c6a1408243df52a0fd8a6d6b1`. `admission_sheet_tickets` — 3. Реальные QR-значения в отчёт не включены.
- Оплаты: `sales` — 50 записей, сумма 72 600 000 коп., 1 отменённая (non-void 70 100 000 коп.); `expenses` — 19, сумма 41 750 000 коп., отменённых 0.
- История проходов: один билет отмечен как пройденный; `touches` содержит 6 154 записей, в том числе `visit_card` 61, `event_signup` 329, `apply` 1 006, `message` 1 962, `reply` 1 737 и др. Детальная история по людям в отчёт не выносится.
- Изменения во время переезда: финальный D1 export снят после заморозки — 2 153 229 байт, sha256 `a3e08516586773dd99794bc5f21976cf2ce67131f891f5eddfaf5002c97fb31b`, совпал с дампом 20.11 22:17. Новых строк в D1 не появилось. После cutover старая D1 не пишется; новые данные идут только в PostgreSQL. Тестовые `touches` (7 шт.) после проверки удалены.
- Старая D1 не удалена: в ней же лежат `erp_*` для ERP/анкеты.

## 4. Проверка функций

| Проверка | Результат | Статус |
|---|---|---|
| Контрольная регистрация через `/api/submit` | HTTP 200 `{"ok":true}`, сообщение ушло в «Заявки»; тестовые `touches` удалены | проверено |
| Получение заявки менеджером | Бот отправил тестовое сообщение в группу «Заявки с Код Роста»; независимо подтвердить прочтение менеджером нельзя | частично |
| Выпуск билета | Локальный `test-admission.mjs` покрывает создание/подтверждение/отмену; production-проверка ждёт реального входа владельца/staff | **не проверено на production** |
| Подтверждение оплаты | Локальные тесты покрывают payment-request/approve; production-проверка ждёт реального входа | **не проверено на production** |
| Разграничение прав | Production: гость без initData — 401 на `/api/admission/tickets`; локальные тесты auth/ролей проходят; реальные owner/staff — ждём вход | частично |
| Однократный проход на тестовом билете | Production-попытка через синтетический initData не использовалась; тестовый билет не создан, реальные билеты не расходовались. Локальный тест «две одновременные проверки: ровно один зелёный проход» проходит | **не проверено на production**; локально проверено |
| QR round-trip | Локальный `test-admission-qr.mjs` исправлен (jsQR/qrcode через browser-sandbox), проходит; production QR из приглашения ждёт тестового билета/телефона | локально проверено; production — **не проверено** |

Локальный прогон: `node --test scripts/test-admission.mjs scripts/test-office.mjs scripts/test-admission-qr.mjs` — **53 теста, 53 pass, 0 fail**. Тесты используют in-memory SQLite и тестовый Telegram, не production.

Важно: production-тест билета не создавал тестовый билет и не расходовал действующие билеты. Для независимой проверки нужен реальный вход owner/staff в production Mini App и отдельный тестовый билет; синтетический initData не использовать.

## 5. Защита рабочей версии

- `/api/admission-demo/*` на production возвращает **404**; demo-сессий нет.
- `runtime-yandex/server-production.mjs` не содержит demo-маршрутов/сессий/подмены fetch; `env-production.mjs` запрещает `ADMISSION_EVENT_ID`, оканчивающийся на `-demo`.
- **Исправлено 21.11:** production-сборка вырезает demo-панели из `admission.html` (`stripDemoMarkup`); проверка `/admission` — 0 совпадений с `demo-banner`/`demo-login`/`manager-preview`/«Я организатор»/«Я хостес», `/api/admission-demo/info` — 404. В исходном `admission.html` и preview demo-разметка сохраняется, в production её нет.
- Реальная авторизация: Telegram WebApp initData, HMAC-SHA256 `WebAppData` + bot token, срок 24 часа; staff — `admission_staff` со `state='approved'`; владелец — по `ADMISSION_OWNER_USERNAME` через `residents.chat_id`; админы офиса — `ADMIN_USERNAMES`. Локальные тесты auth/ролей проходят.
- Google Sheet-синхронизация восстановлена 21.11. Сервисный аккаунт `kodrosta-sheets-reader@kodrosta-bot.iam.gserviceaccount.com` (project `kodrosta-bot`) имеет доступ к обеим таблицам; новый JSON-ключ загружен в Lockbox `kodrosta-google-sheets` и в production env (в отчёт не включён). В app env добавлен `NODE_OPTIONS=--dns-result-order=ipv4first` — без него Node `fetch` к Google периодически падал на IPv6. `syncResidentsFromSheet` прочитал 295 строк: 0 новых, 0 обновлений telegram, 0 изменённых дат абонемента; ошибок нет. Ежедневная синхронизация и проверки продлений снова обеспечены ключом. Metrika не настроена.
- Preview `site-preview.codrosta.club` остаётся отдельным demo/preview-приложением и не является рабочей версией.

## 6. Telegram и автоматизация

- Вебхук: `https://codrosta.club/api/telegram-webhook`, secret_token задан. `getWebhookInfo`: pending 0; последняя ошибка `Connection timed out` с **00:11** — до готовности Caddy; новых ошибок нет. Михаил выполнил `/start`, бот ответил — входящий путь подтверждён пользователем. Публичный путь: без секрета 403, с секретом 200.
- Расписания: один процесс приложения, `DISABLE_SCHEDULER=0`; cron `*/15 * * * *`, `0 3 * * *`, `0 7 * * 1`, `0 6 1 * *` UTC. В логах есть `scheduler-ran */15`. Старый Worker `kodrosta-site` имеет **0 cron**.
- Синхронизации: event reminders, subscription deliveries, обновление `tg_groups`/`tg_group_members` — в приложении; синхронизация билетов с Google Sheet отключена (нет ключа); ERP-синхронизации остаются на Cloudflare.
- Двойных уведомлений/записи: старый Worker снят с custom domain, cron пуст, webhook удалён; старая D1 не пишется; заявки и расписания идут только в новое приложение. ERP использует свою Cloudflare-часть отдельно.
- Остались на Cloudflare: DNS-зона `codrosta.club`; Worker `kodrosta-site` (старый, без трафика); D1 `kodrosta-engagement` (старые данные сайта + legacy `erp_*`); Worker `kodrosta-erp` (legacy; текущая ERP/анкета использует PostgreSQL `kodrosta`); Workers `zadachnik` + D1 `zadachnik`, `kalorimetr-bot`, `kodrosta-obzor`, `maso-ai-specialist`; API-токены. Подробно — раздел 9.

## 7. Копии и возврат

### Код

- GitHub-ветка `codex/yandex-site-preview`, HEAD `ba21f32`; код приложения `ba21f32`.
- Образ `sha256:fc64e69f…` на ВМ.
- Российская копия: `/secure/kodrosta-site-branch.bundle` (18 909 779, sha256 `4aadd8cb…`) и `/secure/kodrosta-site-source.tar.gz` (14 877 069, 235 файлов, sha256 `3ee7a8b5…`).

### Данные

| Копия | Размер | SHA-256 / состояние |
|---|---:|---|
| Ежедневный `/secure/backups/kodrosta_site-2026-11-20T193402Z.dump` | 184 081 | `c43dbc6b…`, timer active |
| Предкатовый `/secure/kodrosta_site-final-before-20261121.dump` | 196 499 | `6cbf2a4b…`, полностью восстановлен в dryrun |
| D1 финальный `/secure/kodrosta-d1-final-20261121.sql` | 2 153 229 | `a3e08516…` |
| D1 rehearsal `/secure/kodrosta-d1-rehearsal-20261121.sql` | 2 153 229 | тот же набор |
| Managed PostgreSQL | 14 дней | автоматические бэкапы кластера |

- Восстановление 21.11: финальный `pg_dump` 196,499 восстановлен в отдельную БД `kodrosta_site_dryrun`; все 22 таблицы, 7 640 строк, QR 3/3 distinct/64/1 checked/агрегат `b51d2d8c…`, sales 50/72 600 000/1 voided, expenses 19/41 750 000/0, `schema_migrations` 21 — совпало.
- Rollback-сценарий 21.11 в отдельной среде: старый D1 финальный SQL загружен в SQLite; в dryrun созданы тестовые заявка/оплата (touch id 6276, sale id 52, 12 345 коп.), перенесены в SQLite с явными ID; counts 6 154→6 155 и 50→51; тестовые строки из PG удалены. Рабочий домен не переключался, рабочая D1 не менялась. Сценарий сохранения новых данных подтверждён; реальный откат с DNS/Worker не выполнялся.
- Старую площадку не удаляю до окончания наблюдения (2–4 недели).

## 8. Эксплуатация

- Обновление: собрать образ из ветки/`Dockerfile.production`, остановить/удалить `kodrosta-site-prod`, запустить с `--network host`, `--env-file /opt/kodrosta-site-prod/private/app.env`, `-v /etc/kodrosta/yandex-ca.pem:/ca.pem:ro`; Caddy уже проксирует на `172.17.0.1:8080`.
- Перезапуск: `sudo docker restart kodrosta-site-prod`; конфиг Caddy — `caddy validate/reload`, Caddyfile read-only, правка через `tee` в тот же inode.
- Логи: `sudo docker logs kodrosta-site-prod`; Caddy — `docker logs kodrosta-intake-web-1`; health — `https://codrosta.club/health/ready`.
- Мониторинг: `kodrosta-site-health.timer` каждые 2 минуты (health, главная, `/api/events`; алерт в «Заявки»), `kodrosta-site-backup.timer` ежедневно 03:30 UTC (pg_dump, pg_restore --list, sha256, 14 дней). Managed PostgreSQL — автоматические бэкапы 14 дней. Yandex Monitoring как отдельный сервис **не настроен**.
- Ресурсы: ВМ `kodrosta-intake-ru`, ru-central1-d, 2 ядра / 2 ГБ, core fraction 20%, диск 9.1 ГБ (4.8 занято); Managed PostgreSQL `kodrosta-residents`, PG 17, `c3-c2-m4` 2 vCPU / 4 ГБ, 20 ГБ network-ssd, бэкапы 14 дней; БД 11 МБ. На ВМ также preview app+db, ERP registry, intake, Caddy.
- Ожидаемый месячный расход Yandex: **не проверено по биллингу**. По конфигурации ориентир — порядка 6–8 тыс. ₽/мес (ВМ + PostgreSQL + диск + публичный IP + трафик/бэкапы); точную сумму нужно снять в биллинге Yandex Cloud.

## 9. Что осталось в Cloudflare

| Ресурс | Назначение | Используется сейчас | Можно ли удалить / основание |
|---|---|---|---|
| DNS-зона `codrosta.club` (NS karl/venus) | DNS домена | Да | Нет; без неё домен не разрешается |
| A `@`, `www` | Основной сайт | Да, DNS only | Нет; указывают на Yandex |
| A `erp`, `anketa` | ERP/анкета | Да, DNS only | Нет; страницы на Yandex |
| A `site-preview` | Preview | Да, DNS only | После решения по preview |
| Worker `kodrosta-site` | Старый сайт | Нет (custom domain снят, cron 0, webhook удалён) | Можно после наблюдения; сейчас оставлен для отката |
| D1 `kodrosta-engagement` | Старые данные сайта + legacy `erp_*` | Текущая ERP/анкета — на PostgreSQL `kodrosta`; D1 `erp_*` не используются | Не удалять без подтверждения; старые данные сайта тоже здесь |
| Worker `kodrosta-erp` | Legacy backend ERP/анкеты | Не используется текущими контейнерами; текущая ERP/анкета на PG `kodrosta` | Не удалять до отдельной проверки |
| Worker `zadachnik` + D1 `zadachnik` | Задачник | Да | Не удалять; другой проект |
| Worker `kalorimetr-bot` | Калориметр | Да/не проверено | Не удалять; другой проект |
| Worker `kodrosta-obzor` | Обзорный сервис | Не проверено | Не удалять до отдельного решения |
| Worker `maso-ai-specialist` | MASO | Да/не проверено | Не удалять; другой проект |
| Cloudflare cron старого `kodrosta-site` | Расписания | Нет (0) | Удалён; восстанавливать только для отката |
| Cloudflare API-токены (DNS, Wrangler OAuth) | DNS/ops | Да | DNS-токен отозвать после наблюдения; OAuth нужен для отката; значения не приводятся |
| R2 / Pages | — | R2 выключен, Pages нет | Удалять нечего |

**Ничего в Cloudflare не удалено.** Старый Worker/D1 сохранены для отката; текущая ERP/анкета использует PostgreSQL `kodrosta`, а Cloudflare `kodrosta-erp`/`erp_*` — legacy. Другие проекты используют Cloudflare.

## 10. Явно не проверено / риски

1. Production-тест билета с однократным проходом не выполнен (401 на синтетической авторизации); реальные билеты не расходовались.
2. Выпуск билета, подтверждение оплаты и права сотрудников на production не проверены.
3. QR round-trip локально исправлен и проходит (53/53); реальный QR из production-приглашения ещё не проверен.
4. Demo-разметка удалена из production-сборки 21.11; source/preview сохраняет demo; production `/admission` — 0, demo API 404. **Исправлено.**
5. Точный месячный расход Yandex не снят из биллинга.
6. Финальный дамп полностью восстановлен в dryrun; rollback-сценарий проверен в отдельной SQLite. Реальный откат с DNS/Worker не выполнялся.
7. Нет подтверждения доступа без VPN с нескольких российских ISP; есть проверка с российской ВМ и сообщение Михаила с телефона.
8. Google Sheet-синхронизация не восстановлена: нет `GOOGLE_SERVICE_ACCOUNT_JSON`; Lockbox: `kodrosta-google-sheets` создан пустым, ключ не добавлен; старый ключ Cloudflare write-only; нужен новый ключ для того же сервисного аккаунта. Metrika не настроена. ERP/анкета фактически на PostgreSQL `kodrosta`; Cloudflare-часть ERP legacy, не используется текущими контейнерами.
9. Yandex Monitoring как отдельный сервис не настроен; только systemd health-check.
10. Российская Git-площадка (SourceCraft) не настроена; есть bundle/архив на ВМ.
11. Независимое подтверждение получения заявки менеджером не сделано.

## Приложение: основные evidence

- HTTP/DNS: `codrosta.club` 200 c IP 130.193.58.254, `Via: 1.1 Caddy`, без `cf-ray`; `www` 301; `erp`/`anketa`/`site-preview` 200; NS karl/venus; A records proxied=false.
- Форма: `POST /api/submit` → 200 `{"ok":true}`; Telegram-сообщение; тестовые `touches` удалены (7 шт.).
- Данные: 22 таблицы / 7 640 строк; residents 298, tickets 3, touches 6 154, sales 50/72 600 000, expenses 19/41 750 000; QR 3×64, 1 checked; агрегат `b51d2d8c…`.
- D1: финальный 2 153 229, sha256 `a3e08516…`; PG: 196 499, `6cbf2a4b…`; ежедневный 184 081, `c43dbc6b…`.
- Код: GitHub `kyznetcovm-hub/kodrosta-site`, branch `codex/yandex-site-preview`, HEAD `8a47a0d` (QR-тест), app `ba21f32`, image `fc64e69f…`, source bundle/archive hashes выше.
- Тесты: 53, pass 53, fail 0; production auth guest 401; demo API 404; demo-разметка в `/admission` 0; webhook public 403/200.
- Планировщик: `scheduler-ran */15 * * * *`; старый cron 0; webhook pending 0, last error 00:11.
- Timers: `kodrosta-site-health.timer` active, `kodrosta-site-backup.timer` active.
