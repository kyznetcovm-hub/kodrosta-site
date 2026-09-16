-- Временная диагностика: почему @Kodrosta (Telegram Business-аккаунт) не
-- регистрируется как админ. Журналируем КАЖДЫЙ входящий апдейт вебхука —
-- from_id/username, как их видит Telegram Bot API, и текст/callback —
-- чтобы увидеть, доходит ли сообщение вообще и что в нём на самом деле.
-- См. src/engagement.js (logIncomingUpdate). Можно будет удалить после
-- того, как разберёмся.

CREATE TABLE IF NOT EXISTS webhook_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id   INTEGER,
    username  TEXT,
    text      TEXT,
    ts        TEXT NOT NULL
);
