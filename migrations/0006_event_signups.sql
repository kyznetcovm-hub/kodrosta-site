-- Записи на мероприятие, собранные ботом (не через сайт) — см. src/event-signups.js.
--   source='bot'    — человек перешёл по ссылке t.me/<бот>?start=e_<eventId> и
--                     нажал «Записаться» (@username и имя из профиля, телефон по желанию).
--   source='manual' — менеджер добавил вручную на карточке мероприятия.
-- Заявки с сайта сюда НЕ пишутся — они остаются в touches (kind='event_signup');
-- «Список участников» в engagement.js объединяет оба хранилища.
--
-- Код также создаёт эти объекты через CREATE ... IF NOT EXISTS (ensureSignupTables),
-- этот файл — для истории схемы и на случай применения миграций через wrangler.

CREATE TABLE IF NOT EXISTS event_signups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT NOT NULL,
    source       TEXT NOT NULL,          -- bot | manual
    tg_user_id   INTEGER,
    username     TEXT,                    -- без @, в нижнем регистре
    person_name  TEXT,
    phone        TEXT,                    -- нормализованный, если поделился контактом
    resident_id  INTEGER,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_signups_event ON event_signups(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_signups_bot
    ON event_signups(event_id, tg_user_id) WHERE tg_user_id IS NOT NULL;
