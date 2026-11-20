-- Колонки, которые рабочий код добавляет в D1 лениво; для production-схемы
-- создаём их заранее, чтобы импорт данных и Mini App «Офис» работали сразу.
ALTER TABLE events ADD COLUMN IF NOT EXISTS plan_participants INTEGER;
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS notified_at TEXT;
