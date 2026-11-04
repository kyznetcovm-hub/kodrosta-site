-- Шаблон доступен после записи как через форму сайта, так и по старой ссылке бота.
UPDATE events
SET full_description = replace(full_description, 'После записи бот пришлёт шаблон', 'После записи доступен шаблон')
WHERE id = 'maso-hr-20261110' AND tag = 'Партнёр · ИИ МАСО';
