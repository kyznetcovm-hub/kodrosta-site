-- Только технический учёт доставки, без копий персональных данных/отчётов.
CREATE TABLE IF NOT EXISTS subscription_deliveries (
  report_date TEXT NOT NULL,
  report_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER,
  PRIMARY KEY (report_date, report_kind)
);
