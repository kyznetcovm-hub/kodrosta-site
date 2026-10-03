# CLAUDE.md

Одностраничный сайт клуба «Код Роста»: статика (HTML/CSS/JS) + Cloudflare Worker с серверной логикой — задеплоено как единый Cloudflare Workers проект (не отдельно Pages).

## Стек и деплой
- Vanilla JS/CSS/HTML, без сборки и без `package.json` — правки применяются напрямую, без `npm run build`.
- Backend: Cloudflare Worker (`src/index.js`) + D1 (`kodrosta-engagement`, см. `wrangler.jsonc`).
- Деплой: `wrangler deploy` из корня проекта.
- Миграции D1: `wrangler d1 migrations apply kodrosta-engagement` (файлы — `migrations/*.sql`, применяются по порядку номеров).
- Локальный просмотр статики: `python3 -m http.server 8080` (Worker-эндпоинты — `/api/*`, `/calendar.ics` — в этом режиме не работают, нужен `wrangler dev`).

## Структура
- `index.html` — вся главная страница целиком (хиро → о клубе → цифры → мероприятия → контакты).
- `css/styles.css` — все стили. Фирменные цвета: `#296EF7` (синий), `#EB344A` (красный).
- `js/main.js` — фронтенд: рендер мероприятий, модалки форм, счётчики, генерация `.ics`.
- `src/index.js` — Worker: раздаёт статику, `POST /api/submit` (заявки → Telegram), `GET /api/events`, `GET /calendar.ics`, `POST /api/telegram-webhook`.
- `src/events-store.js` — мероприятия в D1 + парсинг сообщений из Telegram-бота (формат сообщения см. `EVENT_TEMPLATE.md`).
- `src/engagement.js` — обработка вебхука Telegram-бота, учёт заявок/касаний форм.
- `events-data.js` — отдельный массив мероприятий на фронте; при работе с мероприятиями проверяй, не разошёлся ли он с D1-хранилищем в `events-store.js`.
- `posts-data.js`, `blog.html`, `BLOG_POST_TEMPLATE.md` — блог с отчётами о прошедших мероприятиях.
- `migrations/*.sql` — схема D1.

## Секреты — никогда не хранить в коде
`BOT_TOKEN` и `CHAT_ID` — секреты Worker'а (Cloudflare Dashboard → Variables and Secrets, или `wrangler secret put`). Без них `/api/submit` отвечает `not_configured`.

## Стиль кода
- Без TypeScript и без сборщиков — писать так же, как уже написан код в файле (местами `var`/`function` вместо `let`/стрелочных функций — не менять стиль файла без необходимости).
- Комментарии в коде и весь текст интерфейса — на русском.

## Открытые задачи проекта (детали — в README.md)
- Реальные фото резидентов ещё не добавлены (сейчас геометрические заглушки).
- `privacy.html` — типовой черновик, нужна юридическая проверка.
- Реквизиты клуба в футере и `privacy.html` — плейсхолдеры, нужно заполнить реальными.
