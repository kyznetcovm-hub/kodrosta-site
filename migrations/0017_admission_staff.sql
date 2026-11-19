-- Доступ хостес привязан к подписанному числовому Telegram ID, отдельно на событие.
CREATE TABLE IF NOT EXISTS admission_staff (
  event_id TEXT NOT NULL, telegram_id INTEGER NOT NULL,
  person_name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('pending','approved','revoked')),
  requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
  PRIMARY KEY(event_id,telegram_id)
);
