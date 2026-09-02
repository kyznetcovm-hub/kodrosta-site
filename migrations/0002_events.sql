-- Мероприятия, публикуемые через Telegram-бота (см. src/events-store.js).
-- Источник истины для сайта вместо events-data.js (который остаётся только
-- как справочный пример формата).

CREATE TABLE IF NOT EXISTS events (
    id                TEXT PRIMARY KEY,   -- слаг, генерируется из названия
    title             TEXT NOT NULL,
    tag               TEXT NOT NULL,
    start             TEXT NOT NULL,      -- ISO 8601
    end               TEXT NOT NULL,      -- ISO 8601
    place             TEXT NOT NULL,
    description       TEXT NOT NULL,      -- короткое, для карточки
    full_description  TEXT,               -- JSON-массив абзацев или NULL
    register_url      TEXT,
    created_at        TEXT NOT NULL,
    created_by        TEXT,               -- telegram username, кто опубликовал
    signup_chat_id    INTEGER             -- привязанная Telegram-группа мероприятия (см. «Список участников»),
                                           -- NULL, пока админ её не выбрал через бота
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);
