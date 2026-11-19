-- Билеты и однократная регистрация входа. Тестовое событие имеет отдельный event_id.
CREATE TABLE IF NOT EXISTS admission_tickets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  person_name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','cancelled')),
  checked_in_at TEXT,
  checked_in_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admission_event ON admission_tickets(event_id);
