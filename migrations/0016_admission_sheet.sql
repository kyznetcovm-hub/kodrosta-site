CREATE TABLE IF NOT EXISTS admission_sheet_tickets (
  ticket_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, source_id TEXT NOT NULL,
  tariff TEXT NOT NULL, payment_status TEXT NOT NULL, expected_kopeks INTEGER NOT NULL,
  received_kopeks INTEGER, payment_date TEXT, synced_at TEXT NOT NULL,
  UNIQUE(event_id, source_id)
);
