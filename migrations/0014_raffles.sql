-- История розыгрышей («Рандомайзер», src/randomizer.js): событие, сколько человек
-- участвовало и кто выиграл. Списки всех участников не хранятся — только победители.
-- Код создаёт таблицу сам (ensureRaffleTable); файл — для истории схемы.
CREATE TABLE IF NOT EXISTS raffles (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           TEXT NOT NULL,
    event_title        TEXT NOT NULL,
    participants_count INTEGER NOT NULL,
    winners_json       TEXT NOT NULL,   -- [{ "name": "...", "username": "..." }]
    drawn_by           TEXT,            -- username админа, запустившего розыгрыш
    created_at         TEXT NOT NULL    -- ISO, UTC
);
