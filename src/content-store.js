// Редактируемые текстовые блоки сайта: "О клубе", "Цифры клуба", "Зачем вступать",
// "Как вступить", "Вопросы". Хранятся в D1 (таблица content_fields, key -> value),
// правятся через Telegram-бота — см. engagement.js. index.html отдаёт исходный
// (на момент деплоя) текст как запасной вариант, а js/main.js на клиенте подменяет
// его живыми значениями из GET /api/content.

export var SECTIONS = {
  about: {
    label: "О клубе",
    fields: [
      { key: "about.lead", label: "Ведущий текст" },
      { key: "about.card1.title", label: "Карточка 1 — заголовок" },
      { key: "about.card1.text", label: "Карточка 1 — текст" },
      { key: "about.card2.title", label: "Карточка 2 — заголовок" },
      { key: "about.card2.text", label: "Карточка 2 — текст" },
      { key: "about.card3.title", label: "Карточка 3 — заголовок" },
      { key: "about.card3.text", label: "Карточка 3 — текст" },
    ],
  },
  numbers: {
    label: "Цифры клуба",
    fields: [
      { key: "numbers.stat1.number", label: "Показатель 1 — число" },
      { key: "numbers.stat1.label", label: "Показатель 1 — подпись" },
      { key: "numbers.stat2.number", label: "Показатель 2 — число" },
      { key: "numbers.stat2.label", label: "Показатель 2 — подпись" },
      { key: "numbers.stat3.number", label: "Показатель 3 — число" },
      { key: "numbers.stat3.label", label: "Показатель 3 — подпись" },
      { key: "numbers.stat4.number", label: "Показатель 4 — число" },
      { key: "numbers.stat4.label", label: "Показатель 4 — подпись" },
    ],
  },
  why: {
    label: "Зачем вступать",
    fields: [
      { key: "why.card1.title", label: "Карточка 1 — заголовок" },
      { key: "why.card1.text", label: "Карточка 1 — текст" },
      { key: "why.card2.title", label: "Карточка 2 — заголовок" },
      { key: "why.card2.text", label: "Карточка 2 — текст" },
      { key: "why.card3.title", label: "Карточка 3 — заголовок" },
      { key: "why.card3.text", label: "Карточка 3 — текст" },
      { key: "why.card4.title", label: "Карточка 4 — заголовок" },
      { key: "why.card4.text", label: "Карточка 4 — текст" },
      { key: "why.card5.title", label: "Карточка 5 — заголовок" },
      { key: "why.card5.text", label: "Карточка 5 — текст" },
      { key: "why.card6.title", label: "Карточка 6 — заголовок" },
      { key: "why.card6.text", label: "Карточка 6 — текст" },
    ],
  },
  how: {
    label: "Как вступить",
    fields: [
      { key: "how.subtitle", label: "Подзаголовок" },
      { key: "how.step1.title", label: "Шаг 1 — заголовок" },
      { key: "how.step1.text", label: "Шаг 1 — текст" },
      { key: "how.step2.title", label: "Шаг 2 — заголовок" },
      { key: "how.step2.text", label: "Шаг 2 — текст" },
      { key: "how.step3.title", label: "Шаг 3 — заголовок" },
      { key: "how.step3.text", label: "Шаг 3 — текст" },
      { key: "how.step4.title", label: "Шаг 4 — заголовок" },
      { key: "how.step4.text", label: "Шаг 4 — текст" },
    ],
  },
  faq: {
    label: "Вопросы",
    fields: [
      { key: "faq.q1.question", label: "Вопрос 1" },
      { key: "faq.q1.answer", label: "Ответ 1" },
      { key: "faq.q2.question", label: "Вопрос 2" },
      { key: "faq.q2.answer", label: "Ответ 2" },
      { key: "faq.q3.question", label: "Вопрос 3" },
      { key: "faq.q3.answer", label: "Ответ 3" },
      { key: "faq.q4.question", label: "Вопрос 4" },
      { key: "faq.q4.answer", label: "Ответ 4" },
      { key: "faq.q5.question", label: "Вопрос 5" },
      { key: "faq.q5.answer", label: "Ответ 5" },
      { key: "faq.q6.question", label: "Вопрос 6" },
      { key: "faq.q6.answer", label: "Ответ 6" },
    ],
  },
};

export var SECTION_ORDER = ["about", "numbers", "why", "how", "faq"];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Текущие значения (key -> value) для раздела -> текст-шаблон "Метка: значение",
// который бот присылает админу для редактирования.
export function renderSectionTemplate(sectionKey, values) {
  var section = SECTIONS[sectionKey];
  return section.fields
    .map(function (f) {
      return f.label + ": " + (values[f.key] || "");
    })
    .join("\n\n");
}

// Разбирает присланный админом текст обратно в {key: value} по меткам раздела.
// Значение поля — всё до следующей распознанной метки (может быть многострочным).
export function parseSectionReply(sectionKey, text) {
  var section = SECTIONS[sectionKey];
  var labelPattern = section.fields.map(function (f) { return escapeRegex(f.label); }).join("|");
  var labelLineRe = new RegExp("^\\s*(" + labelPattern + ")\\s*[:：]\\s*(.*)$", "i");
  var lines = text.split("\n");

  var matches = [];
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(labelLineRe);
    if (m) matches.push({ lineIndex: i, label: m[1].trim(), firstLineValue: m[2] });
  }

  var result = {};
  for (var j = 0; j < matches.length; j++) {
    var start = matches[j].lineIndex;
    var end = j + 1 < matches.length ? matches[j + 1].lineIndex : lines.length;
    var valueLines = [matches[j].firstLineValue].concat(lines.slice(start + 1, end));
    var value = valueLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    var field = section.fields.filter(function (f) {
      return f.label.toLowerCase() === matches[j].label.toLowerCase();
    })[0];
    if (field && value) result[field.key] = value;
  }
  return result;
}

export async function getSectionValues(db, sectionKey) {
  var section = SECTIONS[sectionKey];
  var keys = section.fields.map(function (f) { return f.key; });
  var placeholders = keys.map(function () { return "?"; }).join(",");
  var stmt = db.prepare("SELECT key, value FROM content_fields WHERE key IN (" + placeholders + ")");
  var { results } = await stmt.bind.apply(stmt, keys).all();
  var map = {};
  (results || []).forEach(function (r) { map[r.key] = r.value; });
  return map;
}

export async function getAllContent(db) {
  var { results } = await db.prepare("SELECT key, value FROM content_fields").all();
  var map = {};
  (results || []).forEach(function (r) { map[r.key] = r.value; });
  return map;
}

export async function setSectionValues(db, values, updatedBy) {
  var now = new Date().toISOString();
  var keys = Object.keys(values);
  for (var i = 0; i < keys.length; i++) {
    await db
      .prepare(
        "INSERT INTO content_fields (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
      )
      .bind(keys[i], values[keys[i]], now, updatedBy || null)
      .run();
  }
}

export async function setPendingEdit(db, telegramUserId, section) {
  await db
    .prepare(
      "INSERT INTO pending_edits (telegram_user_id, section, created_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(telegram_user_id) DO UPDATE SET section = excluded.section, created_at = excluded.created_at"
    )
    .bind(telegramUserId, section, new Date().toISOString())
    .run();
}

export async function getPendingEdit(db, telegramUserId) {
  return db.prepare("SELECT section FROM pending_edits WHERE telegram_user_id = ?").bind(telegramUserId).first();
}

export async function clearPendingEdit(db, telegramUserId) {
  await db.prepare("DELETE FROM pending_edits WHERE telegram_user_id = ?").bind(telegramUserId).run();
}
