# Отчёт о переносе codrosta.club на Yandex Cloud

Дата: 21 ноября 2026. Статус: **cutover выполнен**, идёт согласованный период наблюдения. Отчёт для независимой проверки. Секреты, пароли, ключи, QR-токены и персональные данные не включены.

## Кратко: сделано / проверено / осталось

**Сделано.** Основной сайт, премия, допуск/билеты, ERP и анкета обслуживаются с Yandex Cloud; DNS-зона осталась в Cloudflare, но A-записи переведены на ВМ без проксирования. PostgreSQL `kodrosta_site` с 22 таблицами и 7 640 строками; форма, Telegram-вебхук, планировщик, health-check и бэкапы работают. Старый Worker/D1 сохранены для отката, старый сайт отключён.

**Проверено.** DNS/A/NS, HTTPS и страницы; независимая от Cloudflare раздача; импорт и сверка данных; форма с реальным ботом; планировщик; health/backup timers; публичный путь вебхука; локальные интеграционные тесты (52 из 53); отсутствие demo-API; исходники/образ/бэкапы.

**Осталось / не проверено.** Production-тест билета с однократным проходом не выполнен: синтетическая авторизация владельца получила 401, тестовый билет не создан, реальные билеты не расходовались. Подтверждение оплаты и права сотрудников на production не проверены. Локальный QR round-trip тест падает (1 из 53). В production HTML осталась скрытая demo-разметка «Я организатор / Я хостес». Точный месячный расход Yandex не снят из биллинга. Полное восстановление финального дампа и rollback-учения не проводились.

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
- **Важно:** страницы ERP и анкеты отдаются с Yandex, но их данные/API, по конфигурации, остаются на Cloudflare Worker `kodrosta-erp` и D1 `kodrosta-engagement` (`erp_*` не переносились). Фактическую трассировку API-трафика ERP/анкеты я не делал — это **не проверено**; вывод основан на составе Cloudflare-ресурсов и контейнерах на ВМ.

## 2. Код

| Параметр | Значение |
|---|---|
| Репозиторий | `https://github.com/kyznetcovm-hub/kodrosta-site` |
| Ветка | `codex/yandex-site-preview` |
| HEAD ветки | `d2d3361` (ops-коммиты после выкладки) |
| Код приложения в образе | `95f8107` (PostgreSQL runtime DDL no-op; схема только миграциями) |
| Образ | `kodrosta-site-prod:2026-11-20`, image id `sha256:64ed2cd791ba2f6d945ed7d1ae05f9761538be02f2346be3958e0c64ff438687`, собран 21.11.2026 00:26 MSK |
| Контейнер | `kodrosta-site-prod`, host network |
| Код внутри образа | `/app` (`/app/src`, `/app/runtime-yandex`, `/app/migrations`, `/app/public-production`) |
| Конфиг на ВМ | `/opt/kodrosta-site-prod/private/app.env` (600; значения не приводятся) |
| Caddy | `/opt/kodrosta/d717f4b34864cac915735ad989900928eb1752ed/infra/Caddyfile` |
| Российская копия исходников | `/secure/kodrosta-site-branch.bundle` — 18 897 255 байт, sha256 `aef0745228e15dbc6abe8e63757bb8c4d3fad3c107e3fe1fb5d272b509bb515c`; `/secure/kodrosta-site-source.tar.gz` — 128 513 байт, 69 файлов, sha256 `4b08cf8bb31ada925a0d6bbbe1b5e75688f15a2e4551bdd4b7c7b04a06325d6a` |
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
| Выпуск билета | На production не проверено; локальный `test-admission.mjs` покрывает создание/подтверждение/отмену | **не проверено на production** |
| Подтверждение оплаты | На production не проверено; ERP/платежи вне периметра переноса | **не проверено** |
| Разграничение прав | Production: гость без initData получает 401 на `/api/admission/tickets`; локальные тесты auth/ролей проходят | частично |
| Однократный проход на тестовом билете | Production-попытка: синтетический initData владельца → 401, тестовый билет не создан, реальные билеты не расходовались. Локальный тест «две одновременные проверки: ровно один зелёный проход» проходит | **не проверено на production**; локально проверено |
| QR round-trip | Локальный `test-admission-qr.mjs` падает; production QR не проверялся | **есть падение, production не проверено** |

Локальный прогон: `node --test scripts/test-admission.mjs scripts/test-office.mjs scripts/test-admission-qr.mjs` — **53 теста, 52 pass, 1 fail** (QR). Тесты используют in-memory SQLite и тестовый Telegram, не production.

Важно: production-тест билета не создавал тестовый билет и не расходовал действующие билеты. Для независимой проверки однократного прохода нужен отдельный тестовый билет в тестовом событии либо доступ к production Mini App с подтверждённым staff/owner.

## 5. Защита рабочей версии

- `/api/admission-demo/*` на production возвращает **404**; demo-сессий нет.
- `runtime-yandex/server-production.mjs` не содержит demo-маршрутов/сессий/подмены fetch; `env-production.mjs` запрещает `ADMISSION_EVENT_ID`, оканчивающийся на `-demo`.
- **Найдено отклонение:** production `/admission` HTML содержит скрытые `#demo-banner`, `#demo-login` с кнопками «Я организатор» и «Я хостес», `#manager-preview`. Они скрыты (`hidden`) и не активируются, потому что demo-API 404, но требование «отсутствуют» буквально не выполнено. Нужно вырезать demo-разметку из production-сборки `public-production/admission.html` или отдавать production-only HTML.
- Реальная авторизация: Telegram WebApp initData, HMAC-SHA256 `WebAppData` + bot token, срок 24 часа; staff — `admission_staff` со `state='approved'`; владелец — по `ADMISSION_OWNER_USERNAME` через `residents.chat_id`; админы офиса — `ADMIN_USERNAMES`. Локальные тесты auth/ролей проходят.
- Google-интеграция: `GOOGLE_*` не заполнены, синхронизация с Google Sheet новых билетов/резидентов **не работает**; это не заглушка, а отключённая опция. Metrika тоже не настроена. Существующие билеты/QR от этого не зависят.
- Preview `site-preview.codrosta.club` остаётся отдельным demo/preview-приложением и не является рабочей версией.

## 6. Telegram и автоматизация

- Вебхук: `https://codrosta.club/api/telegram-webhook`, secret_token задан. `getWebhookInfo`: pending 0; последняя ошибка `Connection timed out` с **00:11** — до готовности Caddy; новых ошибок нет. Михаил выполнил `/start`, бот ответил — входящий путь подтверждён пользователем. Публичный путь: без секрета 403, с секретом 200.
- Расписания: один процесс приложения, `DISABLE_SCHEDULER=0`; cron `*/15 * * * *`, `0 3 * * *`, `0 7 * * 1`, `0 6 1 * *` UTC. В логах есть `scheduler-ran */15`. Старый Worker `kodrosta-site` имеет **0 cron**.
- Синхронизации: event reminders, subscription deliveries, обновление `tg_groups`/`tg_group_members` — в приложении; синхронизация билетов с Google Sheet отключена (нет ключа); ERP-синхронизации остаются на Cloudflare.
- Двойных уведомлений/записи: старый Worker снят с custom domain, cron пуст, webhook удалён; старая D1 не пишется; заявки и расписания идут только в новое приложение. ERP использует свою Cloudflare-часть отдельно.
- Остались на Cloudflare: DNS-зона `codrosta.club`; Worker `kodrosta-site` (старый, без трафика); D1 `kodrosta-engagement` (старые данные сайта + `erp_*`); Worker `kodrosta-erp` (ERP/анкета); Workers `zadachnik` + D1 `zadachnik`, `kalorimetr-bot`, `kodrosta-obzor`, `maso-ai-specialist`; API-токены. Подробно — раздел 9.

## 7. Копии и возврат

### Код

- GitHub-ветка `codex/yandex-site-preview`, HEAD `d2d3361`; код приложения `95f8107`.
- Образ `sha256:64ed2cd…` на ВМ.
- Российская копия: `/secure/kodrosta-site-branch.bundle` (18 897 255, sha256 `aef07452…`) и `/secure/kodrosta-site-source.tar.gz` (128 513, 69 файлов, sha256 `4b08cf8b…`).

### Данные

| Копия | Размер | SHA-256 / состояние |
|---|---:|---|
| Ежедневный `/secure/backups/kodrosta_site-2026-11-20T193402Z.dump` | 184 081 | `c43dbc6b…`, timer active |
| Предкатовый `/secure/kodrosta_site-final-before-20261121.dump` | 196 499 | `6cbf2a4b…`, `pg_restore --list` OK |
| D1 финальный `/secure/kodrosta-d1-final-20261121.sql` | 2 153 229 | `a3e08516…` |
| D1 rehearsal `/secure/kodrosta-d1-rehearsal-20261121.sql` | 2 153 229 | тот же набор |
| Managed PostgreSQL | 14 дней | автоматические бэкапы кластера |

- Восстановление в отдельной среде `kodrosta_site_dryrun` проверялось на дампе 20.11: residents 298, admission_tickets 3, touches 6 154; затем dryrun очищен. Полное восстановление именно финального 196 499-байтного дампа не повторялось — **не проверено**; проверен только `pg_restore --list`.
- Rollback: старый Worker/D1 сохранены, custom domain/cron/webhook можно вернуть; DNS-токен есть. Но новые заявки/оплаты после cutover находятся только в PostgreSQL. Для возврата их нужно выгрузить из PG и импортировать в D1 (обратный адаптер) — **не реализовано и не проверено**. Rollback-учение не проводилось. Реальные сроки/потери при откате не подтверждены.
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
| D1 `kodrosta-engagement` | Старые данные сайта + `erp_*` | Да, ERP/анкета | Нельзя до миграции ERP; старые данные сайта тоже здесь |
| Worker `kodrosta-erp` | Backend ERP/анкеты | Да | Нельзя; ERP не мигрирован |
| Worker `zadachnik` + D1 `zadachnik` | Задачник | Да | Не удалять; другой проект |
| Worker `kalorimetr-bot` | Калориметр | Да/не проверено | Не удалять; другой проект |
| Worker `kodrosta-obzor` | Обзорный сервис | Не проверено | Не удалять до отдельного решения |
| Worker `maso-ai-specialist` | MASO | Да/не проверено | Не удалять; другой проект |
| Cloudflare cron старого `kodrosta-site` | Расписания | Нет (0) | Удалён; восстанавливать только для отката |
| Cloudflare API-токены (DNS, Wrangler OAuth) | DNS/ops | Да | DNS-токен отозвать после наблюдения; OAuth нужен для отката; значения не приводятся |
| R2 / Pages | — | R2 выключен, Pages нет | Удалять нечего |

**Ничего в Cloudflare не удалено.** Старый Worker/D1 сохранены для отката; ERP и другие проекты используют Cloudflare.

## 10. Явно не проверено / риски

1. Production-тест билета с однократным проходом не выполнен (401 на синтетической авторизации); реальные билеты не расходовались.
2. Выпуск билета, подтверждение оплаты и права сотрудников на production не проверены.
3. Локальный QR round-trip тест падает; production QR не проверен.
4. В production `/admission` осталась скрытая demo-разметка «Я организатор / Я хостес»; функционально не активна, но требование «отсутствует» не выполнено.
5. Точный месячный расход Yandex не снят из биллинга.
6. Полное восстановление финального дампа и rollback-учение не проводились.
7. Нет подтверждения доступа без VPN с нескольких российских ISP; есть проверка с российской ВМ и сообщение Михаила с телефона.
8. Google Sheet/Metrika не настроены; ERP/анкета не мигрированы; их данные остаются на Cloudflare.
9. Yandex Monitoring как отдельный сервис не настроен; только systemd health-check.
10. Российская Git-площадка (SourceCraft) не настроена; есть bundle/архив на ВМ.
11. Независимое подтверждение получения заявки менеджером не сделано.

## Приложение: основные evidence

- HTTP/DNS: `codrosta.club` 200 c IP 130.193.58.254, `Via: 1.1 Caddy`, без `cf-ray`; `www` 301; `erp`/`anketa`/`site-preview` 200; NS karl/venus; A records proxied=false.
- Форма: `POST /api/submit` → 200 `{"ok":true}`; Telegram-сообщение; тестовые `touches` удалены (7 шт.).
- Данные: 22 таблицы / 7 640 строк; residents 298, tickets 3, touches 6 154, sales 50/72 600 000, expenses 19/41 750 000; QR 3×64, 1 checked; агрегат `b51d2d8c…`.
- D1: финальный 2 153 229, sha256 `a3e08516…`; PG: 196 499, `6cbf2a4b…`; ежедневный 184 081, `c43dbc6b…`.
- Код: GitHub `kyznetcovm-hub/kodrosta-site`, branch `codex/yandex-site-preview`, HEAD `d2d3361`, app `95f8107`, image `64ed2cd…`, source bundle/archive hashes выше.
- Тесты: 53, pass 52, fail 1 (QR); production auth guest 401; demo API 404; webhook public 403/200.
- Планировщик: `scheduler-ran */15 * * * *`; старый cron 0; webhook pending 0, last error 00:11.
- Timers: `kodrosta-site-health.timer` active, `kodrosta-site-backup.timer` active.
