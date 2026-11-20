-- История редактирования продаж и расходов: ID операции сохраняется.
CREATE TABLE IF NOT EXISTS money_entry_edits (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entry_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  edited_at TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  UNIQUE (kind, entry_id, revision)
);
