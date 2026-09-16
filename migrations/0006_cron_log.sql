-- Журнал срабатываний scheduled() (см. src/index.js) — чтобы можно было
-- проверить прямо в консоли D1, реально ли Cloudflare вызывает cron-триггеры
-- и что при этом произошло, без доступа к живым логам Worker'а.

CREATE TABLE IF NOT EXISTS cron_runs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    cron    TEXT NOT NULL,   -- строка триггера, event.cron ("0 5 * * *" и т.п.)
    job     TEXT NOT NULL,   -- sheet_sync | subscriptions | metrika_digest
    ran_at  TEXT NOT NULL,   -- ISO 8601, момент запуска
    note    TEXT             -- короткий итог: что нашли/отправили/ошибка
);
