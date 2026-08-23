// Хранилище мероприятий в D1 + разбор текста сообщения из Telegram
// (формат — EVENT_TEMPLATE.md). Используется и вебхуком бота (запись),
// и обычным Worker'ом сайта (чтение — /api/events, /calendar.ics).

const MONTHS_RU = {
  "января": 0, "янв": 0,
  "февраля": 1, "фев": 1,
  "марта": 2, "мар": 2,
  "апреля": 3, "апр": 3,
  "мая": 4, "май": 4,
  "июня": 5, "июн": 5,
  "июля": 6, "июл": 6,
  "августа": 7, "авг": 7,
  "сентября": 8, "сен": 8,
  "октября": 9, "окт": 9,
  "ноября": 10, "ноя": 10,
  "декабря": 11, "дек": 11,
};

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

export function slugifyTitle(title) {
  var s = title.toLowerCase().split("").map(function (ch) {
    return TRANSLIT.hasOwnProperty(ch) ? TRANSLIT[ch] : ch;
  }).join("");
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "event";
}

// Достаёт значение поля "Метка: значение" из текста, регистронезависимо,
// до конца строки или следующего распознанного лейбла.
function extractField(text, labels) {
  var lines = text.split("\n");
  var labelRe = new RegExp("^\\s*(" + labels.join("|") + ")\\s*[:：]\\s*(.*)$", "i");
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(labelRe);
    if (m) return { value: m[2], lineIndex: i };
  }
  return null;
}

var ALL_LABELS = [
  "Дата", "Время", "Место проведения \\(название\\)", "Место проведения", "Место",
  "Адрес", "Название мероприятия", "Название", "Категория[^:]*", "Описание", "Регистрация",
];

function extractDescription(text) {
  var lines = text.split("\n");
  var labelRe = new RegExp("^\\s*(" + ALL_LABELS.join("|") + ")\\s*[:：]", "i");
  var startIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*Описание\s*[:：]/i.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  var firstLine = lines[startIdx].replace(/^\s*Описание\s*[:：]\s*/i, "");
  var collected = [firstLine];
  for (var j = startIdx + 1; j < lines.length; j++) {
    if (labelRe.test(lines[j])) break;
    collected.push(lines[j]);
  }
  var full = collected.join("\n").trim();
  return full || null;
}

function parseDate(dateStr) {
  var m = String(dateStr).trim().match(/(\d{1,2})\s+([а-яё]+)/i);
  if (!m) return null;
  var day = parseInt(m[1], 10);
  var monthKey = m[2].toLowerCase();
  var month = MONTHS_RU[monthKey];
  if (month === undefined) {
    for (var key in MONTHS_RU) {
      if (key.indexOf(monthKey.slice(0, 3)) === 0 || monthKey.indexOf(key.slice(0, 3)) === 0) { month = MONTHS_RU[key]; break; }
    }
  }
  if (month === undefined) return null;
  return { day: day, month: month };
}

function parseTimeRange(timeStr) {
  var matches = String(timeStr).match(/(\d{1,2}):(\d{2})/g);
  if (!matches || matches.length === 0) return null;
  var start = matches[0];
  var end = matches[1] || matches[0];
  return { start: start, end: end };
}

function buildIso(day, month, hhmm, now) {
  var year = now.getFullYear();
  var d = new Date(year, month, day, parseInt(hhmm.split(":")[0], 10), parseInt(hhmm.split(":")[1], 10), 0);
  // если дата уже прошла больше чем на сутки — считаем, что имелся в виду следующий год
  if (d.getTime() < now.getTime() - 86400000) {
    d = new Date(year + 1, month, day, parseInt(hhmm.split(":")[0], 10), parseInt(hhmm.split(":")[1], 10), 0);
  }
  return d;
}

function splitParagraphs(text) {
  var parts = text.split(/\n\s*\n/).map(function (p) { return p.replace(/\s+/g, " ").trim(); }).filter(Boolean);
  if (parts.length === 0) {
    var single = text.replace(/\s+/g, " ").trim();
    return single ? [single] : [];
  }
  return parts;
}

function shortenDescription(full, limit) {
  var flat = full.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return { short: flat, needsFull: false };
  var cut = flat.slice(0, limit);
  var lastSentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  var short = lastSentence > limit * 0.5 ? cut.slice(0, lastSentence + 1) : cut.trim() + "…";
  return { short: short, needsFull: true };
}

// Разбирает текст сообщения по формату EVENT_TEMPLATE.md.
// Возвращает { ok:true, event:{...} } или { ok:false, missing:[...] }.
export function parseEventMessage(text, now) {
  now = now || new Date();
  var dateField = extractField(text, ["Дата"]);
  var timeField = extractField(text, ["Время"]);
  var placeField = extractField(text, ["Место проведения \\(название\\)", "Место проведения", "Место"]);
  var addressField = extractField(text, ["Адрес"]);
  var titleField = extractField(text, ["Название мероприятия", "Название"]);
  var tagField = extractField(text, ["Категория[^:]*"]);
  var descriptionRaw = extractDescription(text);
  var registerField = extractField(text, ["Регистрация"]);

  var missing = [];
  if (!dateField || !dateField.value.trim()) missing.push("Дата");
  if (!timeField || !timeField.value.trim()) missing.push("Время");
  if (!placeField || !placeField.value.trim()) missing.push("Место проведения");
  if (!titleField || !titleField.value.trim()) missing.push("Название мероприятия");
  if (!descriptionRaw) missing.push("Описание");

  var parsedDate = dateField ? parseDate(dateField.value) : null;
  if (dateField && !parsedDate) missing.push("Дата (не смог разобрать — формат «26 августа»)");
  var parsedTime = timeField ? parseTimeRange(timeField.value) : null;
  if (timeField && !parsedTime) missing.push("Время (не смог разобрать — формат «16:00 — 18:00»)");

  if (missing.length) return { ok: false, missing: missing };

  var startDate = buildIso(parsedDate.day, parsedDate.month, parsedTime.start, now);
  var endDate = buildIso(parsedDate.day, parsedDate.month, parsedTime.end, now);
  if (endDate.getTime() < startDate.getTime()) endDate = new Date(startDate.getTime() + 2 * 3600000);

  var place = placeField.value.trim();
  if (addressField && addressField.value.trim()) place += ", " + addressField.value.trim();

  var paragraphs = splitParagraphs(descriptionRaw);
  var joined = paragraphs.join(" ");
  var shortened = shortenDescription(joined, 220);
  var fullDescription = shortened.needsFull ? paragraphs : null;

  var registerUrl = registerField && /^https?:\/\//.test(registerField.value.trim()) ? registerField.value.trim() : null;

  return {
    ok: true,
    event: {
      title: titleField.value.trim(),
      tag: tagField && tagField.value.trim() ? tagField.value.trim() : "Мероприятие",
      start: toIsoLocal(startDate),
      end: toIsoLocal(endDate),
      place: place,
      description: shortened.short,
      fullDescription: fullDescription,
      registerUrl: registerUrl,
    },
  };
}

function toIsoLocal(d) {
  function pad(n) { return String(n).padStart(2, "0"); }
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00";
}

export async function insertEvent(db, event, createdBy) {
  var id = slugifyTitle(event.title);
  var existing = await db.prepare("SELECT id FROM events WHERE id = ?").bind(id).first();
  if (existing) id = id + "-" + Date.now().toString().slice(-5);
  await db.prepare(
    "INSERT INTO events (id, title, tag, start, end, place, description, full_description, register_url, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    id, event.title, event.tag, event.start, event.end, event.place, event.description,
    event.fullDescription ? JSON.stringify(event.fullDescription) : null,
    event.registerUrl, new Date().toISOString(), createdBy || null
  ).run();
  return id;
}

export async function deleteEvent(db, id) {
  var res = await db.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  return res.meta && res.meta.changes > 0;
}

export async function listUpcomingEvents(db) {
  var nowIso = new Date().toISOString().slice(0, 19);
  var { results } = await db.prepare("SELECT * FROM events WHERE start >= ? ORDER BY start ASC").bind(nowIso).all();
  return (results || []).map(rowToEvent);
}

export async function listAllEvents(db) {
  var { results } = await db.prepare("SELECT * FROM events ORDER BY start ASC").all();
  return (results || []).map(rowToEvent);
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    tag: row.tag,
    start: row.start,
    end: row.end,
    place: row.place,
    description: row.description,
    fullDescription: row.full_description ? JSON.parse(row.full_description) : undefined,
    registerUrl: row.register_url || undefined,
  };
}
