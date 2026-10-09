-- «Офис в кармане»: из чего складывается план продаж и расходы (src/office-money.js).
-- Код создаёт эти таблицы сам (ensureMoneyTables), файл — для истории схемы.

-- Строки плана: «что × сколько × почём» по статьям. План статьи = сумма строк.
CREATE TABLE IF NOT EXISTS sales_plan_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    month       TEXT NOT NULL,             -- YYYY-MM
    source      TEXT NOT NULL,             -- new | renewal | events | ads
    title       TEXT,
    event_id    TEXT,                      -- если строка про конкретное мероприятие
    qty         INTEGER NOT NULL,
    price_kop   INTEGER NOT NULL,
    pos         INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_items_month ON sales_plan_items(month);

-- Расходы: комиссия менеджерам и себестоимость мероприятий (с привязкой
-- к мероприятию). Как продажи: копейки, отмена без удаления, client_id.
CREATE TABLE IF NOT EXISTS expenses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id      TEXT NOT NULL UNIQUE,
    exp_date       TEXT NOT NULL,          -- YYYY-MM-DD, день оплаты по Москве
    amount_kop     INTEGER NOT NULL,
    category       TEXT NOT NULL,          -- commission | event_cost
    event_id       TEXT,
    comment        TEXT,
    created_at     TEXT NOT NULL,
    created_by_id  INTEGER,
    created_by     TEXT,
    voided_at      TEXT,
    voided_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(exp_date);
