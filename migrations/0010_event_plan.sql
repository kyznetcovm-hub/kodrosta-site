-- План участников мероприятия (целевое число людей) для Mini App «Офис в кармане»:
--   events.plan_participants INTEGER — NULL, пока план не задан.
-- НЕ лимит записи: регистрацию не закрывает.
--
-- Колонку добавляет сам код при первой записи плана (ensureEventPlanColumn в
-- src/events-store.js: PRAGMA table_info + ALTER TABLE events ADD COLUMN
-- plan_participants INTEGER). Здесь ALTER нет намеренно: в SQLite нет
-- «ADD COLUMN IF NOT EXISTS», и повторный ALTER после кода уронил бы
-- `wrangler d1 migrations apply`. Файл — для истории схемы.

SELECT 1;
