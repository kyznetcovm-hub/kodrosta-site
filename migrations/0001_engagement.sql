-- Слой вовлечённости резидентов: кто есть в клубе и когда последний раз касался его.
-- Без баллов/рейтинга — только даты касаний, видно только админам через /cooling.

CREATE TABLE IF NOT EXISTS residents (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name          TEXT NOT NULL,
    phone              TEXT UNIQUE,        -- нормализовано: 11 цифр, начинается с 7
    telegram_username  TEXT,               -- без @, в нижнем регистре
    chat_id            INTEGER UNIQUE,     -- telegram id, заполняется при первом опознании
    industry           TEXT,
    joined_at          TEXT,
    active             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_residents_username ON residents(telegram_username);

CREATE TABLE IF NOT EXISTS touches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    resident_id  INTEGER,            -- NULL, если отправитель не опознан как резидент
    chat_id      INTEGER,            -- telegram id отправителя, если применимо
    kind         TEXT NOT NULL,      -- message | reply | question | linked | attended
                                      -- | visit_card | sale_post | online | event_signup | apply | renewal
    note         TEXT,
    person_name  TEXT,               -- имя с сайта, когда отправитель НЕ опознан как резидент
                                      -- (иначе имя незарегистрированного гостя нигде не сохранится)
    ts           TEXT NOT NULL       -- ISO 8601
);
CREATE INDEX IF NOT EXISTS idx_touches_resident ON touches(resident_id);
CREATE INDEX IF NOT EXISTS idx_touches_chat ON touches(chat_id);
