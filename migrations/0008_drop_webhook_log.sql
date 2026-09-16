-- Убираем временную диагностическую таблицу из migrations/0007 — разобрались
-- (баг был в дубле объявления "const from", ронявшем сборку wrangler), она
-- больше не нужна.

DROP TABLE IF EXISTS webhook_log;
