-- Отправленные напоминания о мероприятиях (за сутки — kind='day', за час — kind='hour'):
-- по одной строке на человека, чтобы cron не слал одно и то же дважды.
-- Код создаёт таблицу сам (ensureReminderTable в src/engagement.js); файл — для истории схемы.
CREATE TABLE IF NOT EXISTS event_reminders (
    event_id  TEXT NOT NULL,
    kind      TEXT NOT NULL,      -- day | hour
    chat_id   INTEGER NOT NULL,
    sent_at   TEXT NOT NULL,
    PRIMARY KEY (event_id, kind, chat_id)
);
