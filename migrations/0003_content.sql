-- Редактируемые текстовые блоки сайта (см. src/content-store.js), правятся через
-- Telegram-бота кнопками "О клубе" / "Цифры клуба" / "Зачем вступать" / "Как вступить" / "Вопросы".

CREATE TABLE IF NOT EXISTS content_fields (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
);

-- Состояние "сейчас редактирует раздел X" — один админ одновременно может
-- редактировать только один раздел, следующее его текстовое сообщение
-- воспринимается как новое содержимое этого раздела.
CREATE TABLE IF NOT EXISTS pending_edits (
    telegram_user_id  INTEGER PRIMARY KEY,
    section           TEXT NOT NULL,
    created_at        TEXT NOT NULL
);
