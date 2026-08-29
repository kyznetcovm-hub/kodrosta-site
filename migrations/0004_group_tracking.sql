-- Учёт состава Telegram-групп, где бот добавлен администратором (см. src/engagement.js).
-- Бот получает апдейты chat_member/my_chat_member (после однократного /setup —
-- он добавляет эти типы в allowed_updates вебхука) и копит сюда участников.
-- Полного списка «задним числом» Telegram боту не отдаёт — учитываются только те,
-- кто вступает после назначения бота админом. Сверка со списком резидентов —
-- кнопкой «Сверка участников» в админ-меню.
--
-- Код создаёт эти таблицы и через CREATE TABLE IF NOT EXISTS (ensureGroupTables),
-- этот файл — для истории схемы и на случай применения миграций через wrangler.

CREATE TABLE IF NOT EXISTS tg_groups (
    chat_id     INTEGER PRIMARY KEY,
    title       TEXT,
    bot_status  TEXT,                       -- administrator | member | left | kicked
    is_admin    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS tg_group_members (
    chat_id     INTEGER NOT NULL,
    tg_user_id  INTEGER NOT NULL,
    username    TEXT,                        -- без @, в нижнем регистре
    first_name  TEXT,
    last_name   TEXT,
    status      TEXT,                        -- member | administrator | creator | restricted | left | kicked
    updated_at  TEXT,
    PRIMARY KEY (chat_id, tg_user_id)
);
