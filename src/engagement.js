// Слой вовлечённости резидентов: приём апдейтов Telegram-бота (вебхук),
// запись касаний из общего чата и с сайта, админ-команды /cooling, /award, /attended.
// Только даты последнего касания — без баллов и рейтинга (сознательное решение,
// публичный рейтинг мог бы демотивировать тех, кто внизу списка).
//
// Публикация мероприятий на сайт (см. events-store.js): админ присылает боту
// текст по формату EVENT_TEMPLATE.md (сообщение начинается со строки "Дата:") —
// это тоже обрабатывается здесь же, тем же вебхуком.

import {
  parseEventMessage, insertEvent, updateEvent, getEventById, deleteEvent,
  listUpcomingEvents, renderEventTemplate, setEventSignupChatId,
} from "./events-store.js";
import {
  SECTIONS, SECTION_ORDER, renderSectionTemplate, parseSectionReply,
  getSectionValues, setSectionValues, setPendingEdit, getPendingEdit, clearPendingEdit,
} from "./content-store.js";

export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return "7" + digits.slice(1);
  return digits;
}

export function normalizeUsername(raw) {
  return String(raw || "").replace(/^@/, "").trim().toLowerCase();
}

function isAdmin(username, env) {
  const admins = String(env.ADMIN_USERNAMES || "")
    .split(",")
    .map(normalizeUsername)
    .filter(Boolean);
  return admins.includes(normalizeUsername(username));
}

async function findResidentByPhone(db, phone) {
  if (!phone) return null;
  return db.prepare("SELECT * FROM residents WHERE phone = ?").bind(phone).first();
}

async function findResidentByUsername(db, username) {
  const u = normalizeUsername(username);
  if (!u) return null;
  return db.prepare("SELECT * FROM residents WHERE telegram_username = ?").bind(u).first();
}

async function findResidentByChatId(db, chatId) {
  return db.prepare("SELECT * FROM residents WHERE chat_id = ?").bind(chatId).first();
}

async function recordTouch(db, residentId, chatId, kind, note, personName) {
  await db
    .prepare("INSERT INTO touches (resident_id, chat_id, kind, note, person_name, ts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(residentId ?? null, chatId ?? null, kind, note ?? null, personName ?? null, new Date().toISOString())
    .run();
}

async function backfillUsername(db, resident, from) {
  if (resident && from.username && !resident.telegram_username) {
    await db
      .prepare("UPDATE residents SET telegram_username = ? WHERE id = ?")
      .bind(normalizeUsername(from.username), resident.id)
      .run();
  }
}

// Вызывается из /api/submit на сайте: заявка на вступление или запись на
// мероприятие — это тоже касание, и заодно резидент подвязывается по телефону.
export async function recordFormTouch(env, { phone, telegramHandle, kind, note, name }) {
  if (!env.DB) return; // база ещё не подключена — не должно ломать основную форму
  try {
    const normPhone = normalizePhone(phone);
    let resident = await findResidentByPhone(env.DB, normPhone);
    if (!resident && telegramHandle) resident = await findResidentByUsername(env.DB, telegramHandle);
    // Имя сохраняем всегда, не только для неопознанных — если резидент напишет
    // на сайте другое имя, будет видно в «Списке участников» именно оно.
    await recordTouch(env.DB, resident ? resident.id : null, null, kind, note, name || null);
  } catch (err) {
    console.error("recordFormTouch failed", err);
  }
}

export async function handleTelegramUpdate(update, env) {
  if (update.callback_query) return handleCallbackQuery(update.callback_query, env);
  if (update.my_chat_member) return handleMyChatMember(update.my_chat_member, env);
  if (update.chat_member) return handleChatMember(update.chat_member, env);

  const msg = update.message;
  if (!msg || !env.DB) return;

  const from = msg.from || {};
  if (from.is_bot) return;

  const chat = msg.chat || {};

  // Служебные сообщения о вступлении/выходе в ЛЮБОЙ группе с ботом — копим состав.
  if (msg.new_chat_members || msg.left_chat_member) {
    await recordServiceMembership(msg, env);
  }

  // Касания считаем в клубном чате резидентов И в любой другой группе, где бот —
  // администратор (например, группы записи на конкретное мероприятие: бот добавлен
  // туда первым, значит те, кто там появляется — тоже наши резиденты на связи).
  if (await isTrackedGroup(env, chat)) {
    return handleGroupMessage(msg, env);
  }

  if (msg.contact) return handleContact(msg, env);

  const text = (msg.text || "").trim();

  // Если админ сейчас редактирует раздел сайта или мероприятие — любое НЕкомандное
  // сообщение воспринимается как новое содержимое, а не как что-то ещё.
  if (!text.startsWith("/") && isAdmin(from.username, env)) {
    const pending = await getPendingEdit(env.DB, from.id);
    if (pending && pending.section.startsWith("event:")) {
      return handleEventEditReply(msg, env, text, pending.section.slice(6));
    }
    if (pending) return handleContentEditReply(msg, env, text, pending.section);
  }

  if (text.startsWith("/cooling")) return handleCoolingCommand(msg, env);
  if (text.startsWith("/setup")) return handleSetupCommand(msg, env);
  if (text.startsWith("/match")) return handleMatchCommand(msg, env, text);
  if (text.startsWith("/award")) return handleAwardCommand(msg, env, text);
  if (text.startsWith("/attended")) return handleAttendedCommand(msg, env, text);
  if (text.startsWith("/events")) return handleListEventsCommand(msg, env);
  if (text.startsWith("/delevent")) return handleDeleteEventCommand(msg, env, text);
  if (/^Дата\s*[:：]/im.test(text)) return handleNewEventCommand(msg, env, text);
  if (text.startsWith("/menu")) return handleMenu(msg, env);
  if (text.startsWith("/start")) return handleStart(msg, env);

  // Личка, ничего не распознали — подсказываем ID на будущее (не групповой чат)
  if (chat.type === "private") {
    return sendMessage(env, from.id, `Не понял сообщение как команду. Ваш Telegram ID: ${from.id}`);
  }
}

// ---- Кнопочное меню для админов -------------------------------------------

// Кнопки с callback_data "noop" — это заголовки-разделители, а не действия:
// по нажатию ничего не происходит (см. handleCallbackQuery).
function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟦 РЕДАКТИРОВАТЬ САЙТ 🟦", callback_data: "noop" }],
      [{ text: "01 · О клубе", callback_data: "content:about" }, { text: "02 · Цифры клуба", callback_data: "content:numbers" }],
      [{ text: "03 · Зачем вступать", callback_data: "content:why" }, { text: "04 · Как вступить", callback_data: "content:how" }],
      [{ text: "05 · Вопросы ▸", callback_data: "menu:faq" }],

      [{ text: "🟥 РЕДАКТИРОВАТЬ МЕРОПРИЯТИЯ 🟥", callback_data: "noop" }],
      [{ text: "01 · Список мероприятий", callback_data: "menu:events" }],
      [{ text: "02 · Создать мероприятие", callback_data: "menu:create" }],
      [{ text: "03 · Список участников", callback_data: "menu:signups" }],

      [{ text: "🟩 ВОВЛЕЧЁННОСТЬ 🟩", callback_data: "noop" }],
      [{ text: "📊 Вовлечённость", callback_data: "menu:report" }],

      [{ text: "🟨 СВЕРКА УЧАСТНИКОВ 🟨", callback_data: "noop" }],
      [{ text: "📇 Сверка участников", callback_data: "menu:matchgroups" }],
    ],
  };
}

function backButtonRow() {
  return [{ text: "⬅️ Назад", callback_data: "menu:home" }];
}

// Показывает главное меню и заодно убирает "залипшую" обычную клавиатуру снизу
// (например, кнопку "Поделиться контактом") — обычная клавиатура и инлайн-кнопки
// живут в разных слоях интерфейса Telegram, одним сообщением их не заменить,
// поэтому шлём два: сначала снимаем старую клавиатуру, потом показываем меню.
async function handleMenu(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  if (env.DB) await clearPendingEdit(env.DB, msg.from.id);
  await sendMessage(env, msg.from.id, "Меню", { remove_keyboard: true });
  return sendMessage(env, msg.from.id, "Что нужно сделать?", adminMenuKeyboard());
}

const EVENT_TEMPLATE_TEXT = [
  "Скопируйте, заполните и пришлите этим же сообщением обратно мне:",
  "",
  "Дата: ",
  "Время: с — до",
  "Место проведения (название): ",
  "Адрес: ",
  "Название мероприятия: ",
  "Категория (Обучение / Нетворкинг / Диалог с властью / Экспертиза резидентов / Семейный формат / другое): ",
  "Описание: ",
  "",
  "Регистрация: (необязательно — оставьте пустым, если запись через сайт)",
].join("\n");

async function handleCallbackQuery(cq, env) {
  const from = cq.from || {};
  const data = cq.data || "";
  const fakeMsg = { from };

  if (!isAdmin(from.username, env)) {
    return answerCallback(env, cq.id, "Доступно только менеджеру клуба");
  }

  await answerCallback(env, cq.id);

  if (data === "noop") return; // нажали на заголовок-разделитель — ничего не делаем
  if (data === "menu:home") return handleMenu(fakeMsg, env);
  if (data === "menu:events") return handleListEventsCommand(fakeMsg, env);
  if (data === "menu:report") return handleCoolingCommand(fakeMsg, env);
  if (data === "menu:create") return sendMessage(env, from.id, EVENT_TEMPLATE_TEXT, { inline_keyboard: [backButtonRow()] });
  if (data === "menu:signups") return handleEventSignupsPicker(fakeMsg, env);
  if (data === "menu:faq") return handleFaqPicker(fakeMsg, env);
  if (data === "menu:matchgroups") return handleMatchGroupsPicker(fakeMsg, env);
  if (data.startsWith("cool:")) return handleCoolingDetail(fakeMsg, env, data.slice(5));
  if (data === "menu:match") return sendMatchHelp(fakeMsg, env);
  if (data.startsWith("mg:")) return handleMatchGroup(fakeMsg, env, data.slice(3));
  if (data.startsWith("de:")) return handleDeleteFromPicker(fakeMsg, env, data.slice(3));
  if (data.startsWith("egl:")) return handleEventGroupLinkPicker(fakeMsg, env, data.slice(4));
  if (data.startsWith("egp:")) return handleEventGroupLinkSet(fakeMsg, env, data.slice(4));
  if (data.startsWith("es:")) return handleEventSignupsDetail(fakeMsg, env, data.slice(3));
  if (data.startsWith("ev:")) return handleEventDetail(fakeMsg, env, data.slice(3));
  if (data.startsWith("eved:")) return handleEventEditPrompt(fakeMsg, env, data.slice(5));
  if (data.startsWith("content:")) return handleContentEditPrompt(fakeMsg, env, data.slice(8));
}

// ---- Редактирование текстовых блоков сайта --------------------------------

// Подменю «05 · Вопросы»: шесть кнопок, каждая — отдельный вопрос FAQ.
async function handleFaqPicker(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  const keyboard = {
    inline_keyboard: [
      [{ text: "Сколько стоит", callback_data: "content:faq1" }, { text: "Кто может вступить", callback_data: "content:faq2" }],
      [{ text: "Что после заявки", callback_data: "content:faq3" }, { text: "Можно не резидентам", callback_data: "content:faq4" }],
      [{ text: "В чём отличие", callback_data: "content:faq5" }, { text: "Как подать заявку", callback_data: "content:faq6" }],
      backButtonRow(),
    ],
  };
  return sendMessage(env, msg.from.id, "Какой вопрос отредактировать?", keyboard);
}

async function handleContentEditPrompt(msg, env, section) {
  if (!env.DB || !SECTIONS[section]) return;
  const values = await getSectionValues(env.DB, section);
  const template = renderSectionTemplate(section, values);
  await setPendingEdit(env.DB, msg.from.id, section);
  const text = [
    `Сейчас в разделе «${SECTIONS[section].label}» вот так:`,
    "",
    template,
    "",
    "Пришлите текст целиком в таком же виде — с теми же метками — с изменениями. Что не тронете, останется как есть.",
  ].join("\n");
  return sendMessage(env, msg.from.id, text, { inline_keyboard: [backButtonRow()] });
}

async function handleContentEditReply(msg, env, text, section) {
  if (!SECTIONS[section]) {
    await clearPendingEdit(env.DB, msg.from.id);
    return;
  }
  const parsed = parseSectionReply(section, text);
  if (Object.keys(parsed).length === 0) {
    return sendMessage(
      env,
      msg.from.id,
      "Не нашёл ни одной метки вида «Название: значение» в сообщении. Пришлите текст с теми же метками, что были в шаблоне, либо нажмите «Назад».",
      { inline_keyboard: [backButtonRow()] }
    );
  }
  await setSectionValues(env.DB, parsed, msg.from.username);
  await clearPendingEdit(env.DB, msg.from.id);
  const changed = SECTIONS[section].fields
    .filter((f) => parsed[f.key] !== undefined)
    .map((f) => "• " + f.label)
    .join("\n");
  return sendMessage(
    env, msg.from.id,
    `✅ Обновлено в разделе «${SECTIONS[section].label}»:\n${changed}\n\nПроверьте на сайте — обновится сразу.`,
    { inline_keyboard: [backButtonRow()] }
  );
}

async function handleDeleteFromPicker(msg, env, id) {
  if (!env.DB) return;
  const removed = await deleteEvent(env.DB, id);
  return sendMessage(
    env, msg.from.id,
    removed ? `Удалено: ${id}` : `Не нашёл мероприятие с id ${id}`,
    { inline_keyboard: [backButtonRow()] }
  );
}

async function answerCallback(env, callbackQueryId, text) {
  const body = { callback_query_id: callbackQueryId };
  if (text) { body.text = text; body.show_alert = true; }
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function handleNewEventCommand(msg, env, text) {
  if (!isAdmin(msg.from.username, env)) {
    return sendMessage(env, msg.from.id, "Публиковать мероприятия может только менеджер клуба.");
  }
  if (!env.DB) return sendMessage(env, msg.from.id, "База данных ещё не подключена.");

  const result = parseEventMessage(text);
  if (!result.ok) {
    return sendMessage(
      env,
      msg.from.id,
      `Не хватает или не разобрано:\n${result.missing.map((m) => "• " + m).join("\n")}\n\nПришлите сообщение ещё раз по формату из EVENT_TEMPLATE.md.`
    );
  }

  const id = await insertEvent(env.DB, result.event, msg.from.username);
  const e = result.event;
  const preview = [
    `✅ Опубликовано на сайте (id: ${id})`,
    "",
    `<b>${escapeHtml(e.title)}</b>`,
    `${escapeHtml(e.tag)}`,
    `${formatRuDateTime(e.start)} — ${formatRuTime(e.end)}`,
    `${escapeHtml(e.place)}`,
    "",
    escapeHtml(e.description),
    "",
    `Удалить: /delevent ${id}`,
  ].join("\n");
  return sendMessage(env, msg.from.id, preview);
}

async function handleDeleteEventCommand(msg, env, text) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return;
  const id = text.split(/\s+/)[1];
  if (!id) return sendMessage(env, msg.from.id, "Формат: /delevent id (id пришёл в подтверждении при публикации, или смотрите /events)");
  const removed = await deleteEvent(env.DB, id);
  return sendMessage(env, msg.from.id, removed ? `Удалено: ${id}` : `Не нашёл мероприятие с id ${id}`);
}

async function handleListEventsCommand(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return;
  const events = await listUpcomingEvents(env.DB);
  if (!events.length) {
    return sendMessage(env, msg.from.id, "Актуальных мероприятий нет.", { inline_keyboard: [backButtonRow()] });
  }
  const buttons = events.map((e) => [
    { text: `${formatRuDateTime(e.start)} — ${e.title}`.slice(0, 60), callback_data: `ev:${e.id}` },
  ]);
  buttons.push(backButtonRow());
  return sendMessage(env, msg.from.id, "Мероприятия клуба — нажмите, чтобы посмотреть и изменить:", { inline_keyboard: buttons });
}

// ---- Список записавшихся на мероприятие ------------------------------------
// Два независимых источника, оба реальные люди, не только резиденты:
//   1) Заявки с сайта — kind='event_signup' в touches, note = название
//      мероприятия как ввёл человек. Имя — из residents (если опознан) или
//      person_name (если нет, но записался через форму).
//   2) Участники Telegram-группы мероприятия — tg_group_members, если админ
//      один раз указал, какая группа отвечает этому мероприятию (events.signup_chat_id).
//      Тут все, кто состоит в группе, вне зависимости от того, резидент или нет.
// Пересечение (человек и заполнил форму, и состоит в группе) не убираем —
// нет надёжного способа сопоставить гостя между источниками без резидентской
// привязки, поэтому считаем и показываем раздельно, с пометкой источника.
async function handleEventSignupsPicker(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return;
  const events = await listUpcomingEvents(env.DB);
  if (!events.length) {
    return sendMessage(env, msg.from.id, "Актуальных мероприятий нет.", { inline_keyboard: [backButtonRow()] });
  }
  const buttons = events.map((e) => [
    { text: `${formatRuDateTime(e.start)} — ${e.title}`.slice(0, 60), callback_data: `es:${e.id}` },
  ]);
  buttons.push(backButtonRow());
  return sendMessage(env, msg.from.id, "Какое мероприятие — список записавшихся?", { inline_keyboard: buttons });
}

function titleMatches(a, b) {
  const x = (a || "").trim().toLowerCase();
  const y = (b || "").trim().toLowerCase();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

async function handleEventSignupsDetail(msg, env, id) {
  if (!env.DB) return;
  const e = await getEventById(env.DB, id);
  if (!e) return sendMessage(env, msg.from.id, `Не нашёл мероприятие с id ${id}`, { inline_keyboard: [backButtonRow()] });

  // Источник 1 — заявки с сайта
  const { results: touchRows } = await env.DB.prepare(
    "SELECT t.note, t.person_name, r.full_name AS resident_name FROM touches t " +
    "LEFT JOIN residents r ON r.id = t.resident_id " +
    "WHERE t.kind = 'event_signup' AND t.note IS NOT NULL"
  ).all();
  const siteSeen = new Set();
  const siteNames = [];
  for (const row of touchRows || []) {
    if (!titleMatches(row.note, e.title)) continue;
    const displayName = row.resident_name || row.person_name;
    if (!displayName || siteSeen.has(displayName)) continue;
    siteSeen.add(displayName);
    siteNames.push(displayName);
  }
  siteNames.sort((a, b) => a.localeCompare(b, "ru"));

  // Источник 2 — участники привязанной Telegram-группы (если привязана)
  let groupNames = null;
  let groupTitle = null;
  if (e.signupChatId) {
    const g = await env.DB.prepare("SELECT title FROM tg_groups WHERE chat_id = ?").bind(e.signupChatId).first();
    groupTitle = g ? g.title : null;
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const stmt = env.DB.prepare(
      "SELECT username, first_name, last_name FROM tg_group_members WHERE chat_id = ? AND status IN (" + placeholders + ")"
    );
    const { results } = await stmt.bind.apply(stmt, [e.signupChatId].concat(ACTIVE_STATUSES)).all();
    groupNames = (results || [])
      .map((m) => [m.first_name, m.last_name].filter(Boolean).join(" ") || (m.username ? "@" + m.username : null))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "ru"));
  }

  const lines = [`<b>${escapeHtml(e.title)}</b>`, formatRuDateTime(e.start), ""];

  lines.push(`<b>С сайта: ${siteNames.length}</b>`);
  lines.push(...(siteNames.length ? siteNames.map((n) => "• " + n) : ["  —"]));
  lines.push("");

  if (groupNames === null) {
    lines.push("Группа мероприятия не привязана — список участников группы не учтён.");
  } else {
    lines.push(`<b>Группа «${escapeHtml(groupTitle || String(e.signupChatId))}»: ${groupNames.length}</b>`);
    lines.push(...(groupNames.length ? groupNames.map((n) => "• " + n) : ["  —"]));
    lines.push("");
    lines.push("Совпадения между источниками не убраны — если человек и заполнил форму, и вступил в группу, он посчитан дважды.");
  }

  const keyboard = [];
  keyboard.push([{ text: groupNames === null ? "🔗 Привязать группу мероприятия" : "🔗 Перепривязать группу", callback_data: `egl:${id}` }]);
  keyboard.push(backButtonRow());

  return sendMessage(env, msg.from.id, lines.join("\n"), { inline_keyboard: keyboard });
}

// Кнопка «Привязать группу»: запоминаем, для какого мероприятия выбираем
// группу (через тот же механизм pending, что и редактирование текста), и
// показываем список групп бота — тот же, что и в «Сверке участников».
async function handleEventGroupLinkPicker(msg, env, eventId) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return;
  await ensureGroupTables(env);
  await setPendingEdit(env.DB, msg.from.id, "eventgroup:" + eventId);
  const { results } = await env.DB.prepare(
    "SELECT chat_id, title FROM tg_groups WHERE bot_status IN ('administrator','member','creator') ORDER BY updated_at DESC"
  ).all();
  if (!results || !results.length) {
    return sendMessage(
      env, msg.from.id,
      "Бот пока не состоит ни в одной группе. Добавьте его в группу мероприятия администратором и попробуйте снова.",
      { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: `es:${eventId}` }]] }
    );
  }
  const rows = results.map((g) => [{ text: (g.title || ("Группа " + g.chat_id)).slice(0, 62), callback_data: `egp:${g.chat_id}` }]);
  rows.push([{ text: "⬅️ Назад", callback_data: `es:${eventId}` }]);
  return sendMessage(env, msg.from.id, "Какая группа отвечает этому мероприятию?", { inline_keyboard: rows });
}

async function handleEventGroupLinkSet(msg, env, chatIdRaw) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return;
  const pending = await getPendingEdit(env.DB, msg.from.id);
  if (!pending || !pending.section.startsWith("eventgroup:")) return;
  const eventId = pending.section.slice("eventgroup:".length);
  await clearPendingEdit(env.DB, msg.from.id);
  await setEventSignupChatId(env.DB, eventId, Number(chatIdRaw));
  return handleEventSignupsDetail(msg, env, eventId);
}

async function handleEventDetail(msg, env, id) {
  if (!env.DB) return;
  const e = await getEventById(env.DB, id);
  if (!e) return sendMessage(env, msg.from.id, `Не нашёл мероприятие с id ${id}`, { inline_keyboard: [backButtonRow()] });
  const text = [
    `<b>${escapeHtml(e.title)}</b>`,
    escapeHtml(e.tag),
    `${formatRuDateTime(e.start)} — ${formatRuTime(e.end)}`,
    escapeHtml(e.place),
    "",
    escapeHtml(e.description),
  ].join("\n");
  const keyboard = {
    inline_keyboard: [
      [{ text: "✏️ Изменить", callback_data: `eved:${id}` }, { text: "🗑 Удалить", callback_data: `de:${id}` }],
      backButtonRow(),
    ],
  };
  return sendMessage(env, msg.from.id, text, keyboard);
}

async function handleEventEditPrompt(msg, env, id) {
  if (!env.DB) return;
  const e = await getEventById(env.DB, id);
  if (!e) return sendMessage(env, msg.from.id, `Не нашёл мероприятие с id ${id}`, { inline_keyboard: [backButtonRow()] });
  const template = renderEventTemplate(e);
  await setPendingEdit(env.DB, msg.from.id, "event:" + id);
  const text = [
    "Сейчас у этого мероприятия вот так:",
    "",
    template,
    "",
    "Пришлите текст целиком в таком же виде — с изменениями. Что не тронете, останется как есть.",
  ].join("\n");
  return sendMessage(env, msg.from.id, text, { inline_keyboard: [backButtonRow()] });
}

async function handleEventEditReply(msg, env, text, id) {
  if (!env.DB) return;
  const existing = await getEventById(env.DB, id);
  if (!existing) {
    await clearPendingEdit(env.DB, msg.from.id);
    return sendMessage(env, msg.from.id, `Не нашёл мероприятие с id ${id} — возможно, его уже удалили.`, { inline_keyboard: [backButtonRow()] });
  }
  const result = parseEventMessage(text);
  if (!result.ok) {
    return sendMessage(
      env, msg.from.id,
      `Не хватает или не разобрано:\n${result.missing.map((m) => "• " + m).join("\n")}\n\nПришлите весь текст ещё раз с исправлениями, либо «Назад».`,
      { inline_keyboard: [backButtonRow()] }
    );
  }
  await updateEvent(env.DB, id, result.event);
  await clearPendingEdit(env.DB, msg.from.id);
  return sendMessage(
    env, msg.from.id,
    `✅ Мероприятие обновлено (id: ${id}). Проверьте на сайте — обновится сразу.`,
    { inline_keyboard: [backButtonRow()] }
  );
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MONTHS_FULL_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function formatRuDateTime(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS_FULL_RU[d.getMonth()]}, ${formatRuTime(iso)}`;
}
function formatRuTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function handleGroupMessage(msg, env) {
  const db = env.DB;
  const from = msg.from;

  let resident = await findResidentByChatId(db, from.id);
  if (!resident && from.username) {
    resident = await findResidentByUsername(db, from.username);
    if (resident) {
      await db.prepare("UPDATE residents SET chat_id = ? WHERE id = ?").bind(from.id, resident.id).run();
    }
  }
  await backfillUsername(db, resident, from);
  const residentId = resident ? resident.id : null;

  const text = (msg.text || "").trim();
  if (!text) return;

  // не чаще 1 касания "message" в день на человека
  const today = new Date().toISOString().slice(0, 10);
  const already = await db
    .prepare("SELECT 1 FROM touches WHERE chat_id = ? AND kind = 'message' AND ts LIKE ? LIMIT 1")
    .bind(from.id, today + "%")
    .first();
  if (!already) await recordTouch(db, residentId, from.id, "message");

  const replyTo = msg.reply_to_message;
  if (replyTo && replyTo.from && replyTo.from.id !== from.id) {
    await recordTouch(db, residentId, from.id, "reply");
  } else if (text.includes("?")) {
    await recordTouch(db, residentId, from.id, "question");
  }
}

async function handleContact(msg, env) {
  const contact = msg.contact;
  const from = msg.from;
  if (contact.user_id !== from.id) {
    return sendMessage(env, from.id, "Пожалуйста, поделитесь именно своим контактом (кнопкой снизу).");
  }
  const phone = normalizePhone(contact.phone_number);
  const resident = await findResidentByPhone(env.DB, phone);
  if (!resident) {
    return sendMessage(
      env,
      from.id,
      "Не нашёл ваш номер в списке резидентов. Если вы действующий резидент — напишите @Kodrosta, поправим."
    );
  }
  await env.DB.prepare("UPDATE residents SET chat_id = ? WHERE id = ?").bind(from.id, resident.id).run();
  await backfillUsername(env.DB, resident, from);
  await recordTouch(env.DB, resident.id, from.id, "linked");
  return sendMessage(env, from.id, `Готово, ${resident.full_name} — вы привязаны к системе клуба 🤝`);
}

async function handleStart(msg, env) {
  if (isAdmin(msg.from.username, env)) return handleMenu(msg, env);

  const keyboard = {
    keyboard: [[{ text: "Поделиться контактом", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
  await sendMessage(
    env,
    msg.from.id,
    "Привет! Чтобы клуб мог учитывать вашу активность и не терять тех, кто давно не появлялся — поделитесь, пожалуйста, контактом.",
    keyboard
  );
}

// Считает разбивку резидентов по свежести последнего касания. Общее для краткой
// сводки (кнопки) и полного списка по одной категории.
async function computeCoolingLists(env) {
  const db = env.DB;
  const warnDays = Number(env.COOLING_WARN_DAYS || 45);
  const critDays = Number(env.COOLING_CRITICAL_DAYS || 90);

  const { results: residents } = await db.prepare("SELECT * FROM residents WHERE active = 1").all();
  const now = Date.now();
  const lists = { crit: [], warn: [], ok: [], nodata: [] };

  for (const r of residents) {
    const last = await db
      .prepare("SELECT ts, kind FROM touches WHERE resident_id = ? ORDER BY ts DESC LIMIT 1")
      .bind(r.id)
      .first();
    if (!last) {
      lists.nodata.push(`• ${r.full_name} — нет касаний`);
      continue;
    }
    const days = Math.floor((now - new Date(last.ts).getTime()) / 86400000);
    const line = `• ${r.full_name} — ${days} дн. назад (${last.kind})`;
    if (days >= critDays) lists.crit.push(line);
    else if (days >= warnDays) lists.warn.push(line);
    else lists.ok.push(line);
  }

  return { lists, warnDays, critDays };
}

const COOLING_CATEGORIES = {
  crit: { emoji: "🔴", label: "Критично" },
  warn: { emoji: "🟡", label: "Охлаждаются" },
  nodata: { emoji: "⚪️", label: "Нет данных" },
  ok: { emoji: "🟢", label: "Активны" },
};

// Короткая сводка — 4 строки с кнопками, полный список открывается по нажатию.
async function handleCoolingCommand(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  const { lists, warnDays, critDays } = await computeCoolingLists(env);

  const text = [
    `<b>Отчёт по вовлечённости</b> · ${new Date().toLocaleDateString("ru-RU")}`,
    "",
    `🔴 Критично (${critDays}+ дней): ${lists.crit.length}`,
    `🟡 Охлаждаются (${warnDays}–${critDays} дней): ${lists.warn.length}`,
    `⚪️ Нет данных: ${lists.nodata.length}`,
    `🟢 Активны: ${lists.ok.length}`,
    "",
    "Нажмите на категорию, чтобы посмотреть список.",
  ].join("\n");

  const keyboard = {
    inline_keyboard: [
      [
        { text: `🔴 ${lists.crit.length}`, callback_data: "cool:crit" },
        { text: `🟡 ${lists.warn.length}`, callback_data: "cool:warn" },
      ],
      [
        { text: `⚪️ ${lists.nodata.length}`, callback_data: "cool:nodata" },
        { text: `🟢 ${lists.ok.length}`, callback_data: "cool:ok" },
      ],
      backButtonRow(),
    ],
  };
  return sendMessage(env, msg.from.id, text, keyboard);
}

// Полный список одной категории — открывается по нажатию кнопки в сводке.
async function handleCoolingDetail(msg, env, category) {
  if (!isAdmin(msg.from.username, env)) return;
  const cat = COOLING_CATEGORIES[category];
  if (!cat) return;
  const { lists, warnDays, critDays } = await computeCoolingLists(env);
  const items = lists[category];

  const rangeLabel =
    category === "crit" ? ` (${critDays}+ дней)` :
    category === "warn" ? ` (${warnDays}–${critDays} дней)` : "";

  const report = [
    `<b>${cat.emoji} ${cat.label}${rangeLabel}</b> — ${items.length}`,
    "",
    ...(items.length ? items : ["  —"]),
  ].join("\n");

  const backRow = [{ text: "⬅️ К сводке", callback_data: "menu:report" }];
  for (let i = 0; i < report.length; i += 3500) {
    const isLast = i + 3500 >= report.length;
    await sendMessage(env, msg.from.id, report.slice(i, i + 3500), isLast ? { inline_keyboard: [backRow] } : undefined);
  }
}

// ---- Сверка участников группы со списком резидентов ----------------------
// Админ присылает в личку боту: "/match" и следом (в том же сообщении) —
// список участников Telegram-группы: @ники через пробел, запятую или с новой
// строки (можно вставить и целиком колонку username из выгрузки скрипта).
// Бот отвечает: кто уже резидент, а кого нет — то есть кому слать приглашение.

async function sendMatchHelp(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  return sendMessage(
    env, msg.from.id,
    [
      "Пришлите одним сообщением:",
      "",
      "<code>/match</code>",
      "и следом — список участников группы: @ники через пробел, запятую или с новой строки.",
      "",
      "В ответ пришлю два списка: кто уже резидент клуба, и кого в базе нет — то есть кому можно отправить приглашение.",
    ].join("\n"),
    { inline_keyboard: [backButtonRow()] }
  );
}

const MATCH_STOPWORDS = new Set([
  "username", "user", "first", "last", "name", "phone", "id", "premium",
  "true", "false", "null", "members", "member",
]);

// Ручной ввод: "/match" + вставленный список @ников / телефонов.
async function handleMatchCommand(msg, env, text) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return sendMessage(env, msg.from.id, "База данных не подключена.");

  const payload = text.replace(/^\/match(@\w+)?/i, " ");

  const handles = new Set();
  for (const m of payload.match(/@[A-Za-z0-9_]{4,32}/g) || []) {
    handles.add(normalizeUsername(m));
  }
  for (const tok of payload.split(/[\s,;|]+/)) {
    if (/^[A-Za-z0-9_]{5,32}$/.test(tok) && /[A-Za-z]/.test(tok) && !MATCH_STOPWORDS.has(tok.toLowerCase())) {
      handles.add(normalizeUsername(tok));
    }
  }
  const phones = new Set();
  for (const m of payload.match(/\+?\d[\d\s()\-]{9,}\d/g) || []) {
    const d = m.replace(/\D/g, "").slice(-10);
    if (d.length === 10) phones.add(d);
  }

  if (!handles.size && !phones.size) {
    return sendMatchHelp(msg, env);
  }
  return reportResidentMatch(env, msg.from.id, handles, phones, "<b>Сверка со списком резидентов</b>");
}

// Общий сборщик отчёта: сверяет наборы @ников и телефонов с таблицей residents.
async function reportResidentMatch(env, userId, handlesIn, phonesIn, headerLine) {
  const handles = [...new Set([...handlesIn].filter(Boolean))];
  const phones = [...new Set([...phonesIn])];

  const { results } = await env.DB.prepare(
    "SELECT full_name, telegram_username, phone FROM residents"
  ).all();
  const byUser = new Map();
  const byPhone = new Map();
  for (const r of results || []) {
    if (r.telegram_username) byUser.set(String(r.telegram_username).toLowerCase(), r);
    if (r.phone) byPhone.set(String(r.phone).slice(-10), r);
  }

  const found = [];
  const invite = [];
  for (const h of handles) {
    const r = byUser.get(h);
    if (r) found.push(`@${h} — ${escapeHtml(r.full_name)}`);
    else invite.push("@" + h);
  }
  for (const p of phones) {
    const r = byPhone.get(p);
    if (r) found.push(`тел …${p.slice(-4)} — ${escapeHtml(r.full_name)}`);
    else invite.push("+7" + p);
  }

  const lines = [
    headerLine || "<b>Сверка со списком резидентов</b>",
    `Распознано аккаунтов: ${handles.length + phones.length}`,
    "",
    `✅ Уже резиденты: ${found.length}`,
    ...(found.length ? found.map((s) => "• " + s) : ["  —"]),
    "",
    `✉️ Не в базе — на приглашение: ${invite.length}`,
    ...(invite.length ? invite.map((s) => "• " + s) : ["  —"]),
  ];
  if (invite.length) {
    lines.push("", "Одной строкой для рассылки:", invite.join(" "));
  }

  const report = lines.join("\n");
  for (let i = 0; i < report.length; i += 3500) {
    const isLast = i + 3500 >= report.length;
    await sendMessage(env, userId, report.slice(i, i + 3500), isLast ? { inline_keyboard: [backButtonRow()] } : undefined);
  }
}

// ---- Учёт состава групп, где бот — администратор -------------------------
// Telegram шлёт боту-админу апдейты chat_member на каждое вступление/выход.
// Полного списка «задним числом» бот не получает — только тех, кто вступает
// после его добавления. Всё копится в tg_group_members, сверка — кнопкой.

// Считать ли сообщения этой группы касаниями резидентов. Клубный чат резидентов —
// всегда (даже если бота там временно разжаловали из админов), плюс любая другая
// группа/супергруппа, где бот сейчас администратор (см. tg_groups, наполняется
// через my_chat_member/chat_member — см. handleSetupCommand).
async function isTrackedGroup(env, chat) {
  if (chat.type !== "group" && chat.type !== "supergroup") return false;
  const residentsChatId = Number(env.RESIDENTS_CHAT_ID);
  if (residentsChatId && chat.id === residentsChatId) return true;
  if (!env.DB) return false;
  const row = await env.DB.prepare("SELECT is_admin FROM tg_groups WHERE chat_id = ?").bind(chat.id).first();
  return !!(row && row.is_admin);
}

let groupTablesReady = false;
async function ensureGroupTables(env) {
  if (groupTablesReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS tg_groups (chat_id INTEGER PRIMARY KEY, title TEXT, " +
    "bot_status TEXT, is_admin INTEGER NOT NULL DEFAULT 0, updated_at TEXT)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS tg_group_members (chat_id INTEGER NOT NULL, tg_user_id INTEGER NOT NULL, " +
    "username TEXT, first_name TEXT, last_name TEXT, status TEXT, updated_at TEXT, " +
    "PRIMARY KEY (chat_id, tg_user_id))"
  ).run();
  groupTablesReady = true;
}

const ACTIVE_STATUSES = ["member", "administrator", "creator", "restricted"];

async function upsertGroupMember(env, chatId, user, status) {
  await env.DB.prepare(
    "INSERT INTO tg_group_members (chat_id, tg_user_id, username, first_name, last_name, status, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(chat_id, tg_user_id) DO UPDATE SET username = excluded.username, " +
    "first_name = excluded.first_name, last_name = excluded.last_name, status = excluded.status, updated_at = excluded.updated_at"
  ).bind(
    chatId, user.id,
    user.username ? String(user.username).toLowerCase() : null,
    user.first_name || null, user.last_name || null,
    status, new Date().toISOString()
  ).run();
}

async function touchGroup(env, chat, botStatus) {
  const now = new Date().toISOString();
  if (botStatus) {
    await env.DB.prepare(
      "INSERT INTO tg_groups (chat_id, title, bot_status, is_admin, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, bot_status = excluded.bot_status, " +
      "is_admin = excluded.is_admin, updated_at = excluded.updated_at"
    ).bind(chat.id, chat.title || null, botStatus, botStatus === "administrator" ? 1 : 0, now).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO tg_groups (chat_id, title, bot_status, is_admin, updated_at) VALUES (?, ?, 'administrator', 1, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET title = COALESCE(excluded.title, tg_groups.title), updated_at = excluded.updated_at"
    ).bind(chat.id, chat.title || null, now).run();
  }
}

async function handleMyChatMember(upd, env) {
  if (!env.DB) return;
  const chat = upd.chat || {};
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const status = ((upd.new_chat_member || {}).status) || "left";
  await ensureGroupTables(env);
  await touchGroup(env, chat, status);
}

async function handleChatMember(upd, env) {
  if (!env.DB) return;
  const chat = upd.chat || {};
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const ncm = upd.new_chat_member || {};
  const u = ncm.user || {};
  if (!u.id || u.is_bot) return;
  await ensureGroupTables(env);
  await touchGroup(env, chat, null);
  await upsertGroupMember(env, chat.id, u, ncm.status || "member");
  if (ACTIVE_STATUSES.includes(ncm.status)) await recordEventSignupIfResident(env, chat, u);
}

async function recordServiceMembership(msg, env) {
  if (!env.DB) return;
  const chat = msg.chat || {};
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  await ensureGroupTables(env);
  await touchGroup(env, chat, null);
  for (const u of msg.new_chat_members || []) {
    if (u && u.id && !u.is_bot) {
      await upsertGroupMember(env, chat.id, u, "member");
      await recordEventSignupIfResident(env, chat, u);
    }
  }
  const left = msg.left_chat_member;
  if (left && left.id && !left.is_bot) await upsertGroupMember(env, chat.id, left, "left");
}

// Вступление в группу мероприятия (не в клубный чат резидентов) — сам факт
// членства считаем регистрацией на мероприятие, без ожидания сообщения от человека.
async function recordEventSignupIfResident(env, chat, user) {
  const residentsChatId = Number(env.RESIDENTS_CHAT_ID);
  if (residentsChatId && chat.id === residentsChatId) return;
  if (!user.username) return;
  const resident = await findResidentByUsername(env.DB, user.username);
  if (!resident) return;
  if (!resident.chat_id) {
    await env.DB.prepare("UPDATE residents SET chat_id = ? WHERE id = ?").bind(user.id, resident.id).run();
  }
  await recordTouch(env.DB, resident.id, user.id, "event_signup", chat.title || null);
}

// Кнопка «Сверка участников» -> список групп бота.
async function handleMatchGroupsPicker(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return;
  await ensureGroupTables(env);
  const { results } = await env.DB.prepare(
    "SELECT chat_id, title, is_admin FROM tg_groups WHERE bot_status IN ('administrator','member','creator') ORDER BY updated_at DESC"
  ).all();

  const rows = (results || []).map((g) => [{
    text: ((g.title || ("Группа " + g.chat_id)) + (g.is_admin ? "" : " ⚠️")).slice(0, 62),
    callback_data: "mg:" + g.chat_id,
  }]);
  rows.push([{ text: "✍️ Вставить список вручную", callback_data: "menu:match" }]);
  rows.push(backButtonRow());

  const head = (results && results.length)
    ? "Выберите группу — сверю её участников с базой резидентов.\n⚠️ — бот в группе не администратор, список будет неполным."
    : "Бот пока не добавлен ни в одну группу как администратор.\n\nДобавьте @KodrostaAssistant_bot в группу, назначьте администратором — и он начнёт вести список участников. Потом сверка будет одной кнопкой.\n\nДля уже прошедших групп — «Вставить список вручную».";
  return sendMessage(env, msg.from.id, head, { inline_keyboard: rows });
}

async function handleMatchGroup(msg, env, chatIdRaw) {
  if (!isAdmin(msg.from.username, env)) return;
  if (!env.DB) return;
  const chatId = Number(chatIdRaw);
  await ensureGroupTables(env);
  const g = await env.DB.prepare("SELECT title, is_admin FROM tg_groups WHERE chat_id = ?").bind(chatId).first();
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
  const stmt = env.DB.prepare(
    "SELECT username FROM tg_group_members WHERE chat_id = ? AND status IN (" + placeholders + ")"
  );
  const { results } = await stmt.bind.apply(stmt, [chatId].concat(ACTIVE_STATUSES)).all();

  if (!results || !results.length) {
    return sendMessage(
      env, msg.from.id,
      "По этой группе пока нет данных об участниках.\n\nБот запоминает тех, кто вступает уже ПОСЛЕ того, как его сделали админом — список наполнится по мере вступления людей.",
      { inline_keyboard: [backButtonRow()] }
    );
  }

  const handles = [];
  let noHandle = 0;
  for (const m of results) {
    if (m.username) handles.push(String(m.username).toLowerCase());
    else noHandle++;
  }
  const header =
    `<b>Сверка: ${escapeHtml((g && g.title) || "группа")}</b>\n` +
    `Участников у бота: ${results.length}` +
    (noHandle ? `\nБез @username (не проверить): ${noHandle}` : "") +
    (g && !g.is_admin ? "\n⚠️ бот не админ — список может быть неполным" : "");
  return reportResidentMatch(env, msg.from.id, handles, [], header);
}

async function tgApi(env, method, body) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return await resp.json();
  } catch (e) {
    return null;
  }
}

// Одноразовая настройка: включить приём событий о вступлении/выходе участников.
async function handleSetupCommand(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
  const info = await tgApi(env, "getWebhookInfo");
  const url = info && info.result && info.result.url;
  if (!url) {
    return sendMessage(env, msg.from.id, "Не удалось узнать адрес вебхука бота. Напишите разработчику.");
  }
  const res = await tgApi(env, "setWebhook", {
    url,
    allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"],
  });
  return sendMessage(
    env, msg.from.id,
    res && res.ok
      ? "✅ Готово. Бот теперь получает события о вступлении и выходе участников групп.\n\nДобавьте его в нужную группу администратором — и участники начнут учитываться для «Сверки участников»."
      : "Не получилось включить: " + JSON.stringify(res)
  );
}

async function handleAwardCommand(msg, env, text) {
  if (!isAdmin(msg.from.username, env)) return;
  const KINDS = ["visit_card", "sale_post", "online", "renewal"];
  const [rawUsername, kind, ...rest] = text.split(/\s+/).slice(1);
  if (!rawUsername || !KINDS.includes(kind)) {
    return sendMessage(env, msg.from.id, `Формат: /award @username вид [комментарий]\nВиды: ${KINDS.join(", ")}`);
  }
  const resident = await findResidentByUsername(env.DB, rawUsername);
  if (!resident) return sendMessage(env, msg.from.id, "Резидент с таким telegram не найден в базе.");
  await recordTouch(env.DB, resident.id, resident.chat_id, kind, rest.join(" ") || null);
  return sendMessage(env, msg.from.id, `Отмечено: ${resident.full_name} · ${kind}`);
}

async function handleAttendedCommand(msg, env, text) {
  if (!isAdmin(msg.from.username, env)) return;
  const [event, ...unames] = text.split(/\s+/).slice(1);
  if (!event || unames.length === 0) {
    return sendMessage(env, msg.from.id, "Формат: /attended название_мероприятия @user1 @user2 ...");
  }
  let ok = 0;
  for (const u of unames) {
    const resident = await findResidentByUsername(env.DB, u);
    if (resident) {
      await recordTouch(env.DB, resident.id, resident.chat_id, "attended", event);
      ok++;
    }
  }
  return sendMessage(env, msg.from.id, `Отмечено пришедших: ${ok} из ${unames.length}`);
}

async function sendMessage(env, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
