-- Менеджеры добавляют гостей; Михаил одобряет доступ и оплаты через Telegram.
CREATE TABLE IF NOT EXISTS admission_ticket_details (
  ticket_id TEXT PRIMARY KEY, created_by INTEGER NOT NULL, created_name TEXT NOT NULL,
  expected_kopeks INTEGER NOT NULL, approved_at TEXT, approved_by INTEGER, paid_kopeks INTEGER
);
CREATE TABLE IF NOT EXISTS admission_requests (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','payment')),
  telegram_id INTEGER NOT NULL, person_name TEXT NOT NULL, ticket_id TEXT,
  amount_kopeks INTEGER, comment TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL, decided_at TEXT, decided_by INTEGER, decision_key TEXT,
  notified_at TEXT, notify_claimed_at TEXT, message_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS admission_one_pending_request ON admission_requests
  (event_id,kind,COALESCE(ticket_id,''),CASE WHEN kind='access' THEN telegram_id ELSE 0 END) WHERE state='pending';
