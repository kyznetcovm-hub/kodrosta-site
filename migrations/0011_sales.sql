-- Деньги для Mini App «Офис в кармане» (src/office-money.js).
-- Код создаёт эти таблицы сам (ensureMoneyTables), файл — для истории схемы.

-- Поступления денег, внесённые вручную. Не удаляются: ошибочная запись
-- отменяется (voided_at) и не входит в итоги. Суммы — в копейках.
CREATE TABLE IF NOT EXISTS sales (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id      TEXT NOT NULL UNIQUE,   -- id формы из приложения — защита от повтора
    sale_date      TEXT NOT NULL,          -- YYYY-MM-DD, день поступления по Москве
    amount_kop     INTEGER NOT NULL,
    source         TEXT NOT NULL,          -- new | renewal | events | ads
    event_id       TEXT,                   -- для «Мероприятий» — какое событие, если указали
    comment        TEXT,
    created_at     TEXT NOT NULL,
    created_by_id  INTEGER,
    created_by     TEXT,                   -- username того, кто внёс
    voided_at      TEXT,
    voided_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);

-- План продаж: по статьям (source:<key>) и по неделям (week:<номер с 1>).
-- План месяца = сумма планов по статьям.
CREATE TABLE IF NOT EXISTS sales_plans (
    month       TEXT NOT NULL,             -- YYYY-MM
    scope       TEXT NOT NULL,
    amount_kop  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT,
    PRIMARY KEY (month, scope)
);
