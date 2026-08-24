// Слой вовлечённости резидентов: приём апдейтов Telegram-бота (вебхук),
// запись касаний из общего чата и с сайта, админ-команды /cooling, /award, /attended.
// Только даты последнего касания — без баллов и рейтинга (сознательное решение,
// публичный рейтинг мог бы демотивировать тех, кто внизу списка).
//
// Публикация мероприятий на сайт (см. events-store.js): админ присылает боту
// текст по формату EVENT_TEMPLATE.md (сообщение начинается со строки "Дата:") —
// это тоже обрабатывается здесь же, тем же вебхуком.

import { parseEventMessage, insertEvent, deleteEvent, listAllEvents, listUpcomingEvents } from "./events-store.js";
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

async function recordTouch(db, residentId, chatId, kind, note) {
  await db
    .prepare("INSERT INTO touches (resident_id, chat_id, kind, note, ts) VALUES (?, ?, ?, ?, ?)")
    .bind(residentId ?? null, chatId ?? null, kind, note ?? null, new Date().toISOString())
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
export async function recordFormTouch(env, { phone, telegramHandle, kind, note }) {
  if (!env.DB) return; // база ещё не подключена — не должно ломать основную форму
  try {
    const normPhone = normalizePhone(phone);
    let resident = await findResidentByPhone(env.DB, normPhone);
    if (!resident && telegramHandle) resident = await findResidentByUsername(env.DB, telegramHandle);
    await recordTouch(env.DB, resident ? resident.id : null, null, kind, note);
  } catch (err) {
    console.error("recordFormTouch failed", err);
  }
}

export async function handleTelegramUpdate(update, env) {
  if (update.callback_query) return handleCallbackQuery(update.callback_query, env);

  const msg = update.message;
  if (!msg || !env.DB) return;

  const from = msg.from || {};
  if (from.is_bot) return;

  const residentsChatId = Number(env.RESIDENTS_CHAT_ID);
  const chat = msg.chat || {};
  if (residentsChatId && chat.id === residentsChatId) {
    return handleGroupMessage(msg, env);
  }

  if (msg.contact) return handleContact(msg, env);

  const text = (msg.text || "").trim();

  // Если админ сейчас редактирует раздел сайта — любое НЕкомандное сообщение
  // воспринимается как новое содержимое этого раздела, а не как что-то ещё.
  if (!text.startsWith("/") && isAdmin(from.username, env)) {
    const pending = await getPendingEdit(env.DB, from.id);
    if (pending) return handleContentEditReply(msg, env, text, pending.section);
  }

  if (text.startsWith("/cooling")) return handleCoolingCommand(msg, env);
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

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📋 Посмотреть события", callback_data: "menu:events" }],
      [{ text: "🗑 Удалить событие", callback_data: "menu:delete" }],
      [{ text: "➕ Создать событие", callback_data: "menu:create" }],
      [{ text: "📊 Отчёт вовлечённости", callback_data: "menu:report" }],
      [{ text: "✏️ О клубе", callback_data: "content:about" }],
      [{ text: "✏️ Цифры клуба", callback_data: "content:numbers" }],
      [{ text: "✏️ Зачем вступать", callback_data: "content:why" }],
      [{ text: "✏️ Как вступить", callback_data: "content:how" }],
      [{ text: "✏️ Вопросы", callback_data: "content:faq" }],
    ],
  };
}

async function handleMenu(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
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

  if (data === "menu:events") return handleListEventsCommand(fakeMsg, env);
  if (data === "menu:report") return handleCoolingCommand(fakeMsg, env);
  if (data === "menu:create") return sendMessage(env, from.id, EVENT_TEMPLATE_TEXT);
  if (data === "menu:delete") return handleDeletePicker(fakeMsg, env);
  if (data.startsWith("de:")) return handleDeleteFromPicker(fakeMsg, env, data.slice(3));
  if (data.startsWith("content:")) return handleContentEditPrompt(fakeMsg, env, data.slice(8));
}

// ---- Редактирование текстовых блоков сайта --------------------------------

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
  return sendMessage(env, msg.from.id, text);
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
      "Не нашёл ни одной метки вида «Название: значение» в сообщении. Пришлите текст с теми же метками, что были в шаблоне, либо /menu, чтобы начать заново."
    );
  }
  await setSectionValues(env.DB, parsed, msg.from.username);
  await clearPendingEdit(env.DB, msg.from.id);
  const changed = SECTIONS[section].fields
    .filter((f) => parsed[f.key] !== undefined)
    .map((f) => "• " + f.label)
    .join("\n");
  return sendMessage(env, msg.from.id, `✅ Обновлено в разделе «${SECTIONS[section].label}»:\n${changed}\n\nПроверьте на сайте — обновится сразу.`);
}

async function handleDeletePicker(msg, env) {
  if (!env.DB) return;
  const events = await listUpcomingEvents(env.DB);
  if (!events.length) return sendMessage(env, msg.from.id, "Ближайших мероприятий нет — удалять нечего.");
  const buttons = events.map((e) => [
    { text: `${formatRuDateTime(e.start)} — ${e.title}`.slice(0, 60), callback_data: `de:${e.id}` },
  ]);
  return sendMessage(env, msg.from.id, "Какое мероприятие удалить?", { inline_keyboard: buttons });
}

async function handleDeleteFromPicker(msg, env, id) {
  if (!env.DB) return;
  const removed = await deleteEvent(env.DB, id);
  return sendMessage(env, msg.from.id, removed ? `Удалено: ${id}` : `Не нашёл мероприятие с id ${id}`);
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
  const events = await listAllEvents(env.DB);
  if (!events.length) return sendMessage(env, msg.from.id, "Мероприятий пока нет.");
  const lines = events.map((e) => `• ${formatRuDateTime(e.start)} — ${escapeHtml(e.title)} (id: ${e.id})`);
  return sendMessage(env, msg.from.id, `<b>Мероприятия:</b>\n${lines.join("\n")}`);
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

async function handleCoolingCommand(msg, env) {
  if (!isAdmin(msg.from.username, env)) return;
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

  const report = [
    `<b>Отчёт по вовлечённости</b> · ${new Date().toLocaleDateString("ru-RU")}`,
    "",
    `🔴 Критично (${critDays}+ дней): ${lists.crit.length}`,
    ...(lists.crit.length ? lists.crit : ["  —"]),
    "",
    `🟡 Охлаждаются (${warnDays}–${critDays} дней): ${lists.warn.length}`,
    ...(lists.warn.length ? lists.warn : ["  —"]),
    "",
    `⚪️ Нет данных: ${lists.nodata.length}`,
    ...(lists.nodata.length ? lists.nodata : ["  —"]),
    "",
    `🟢 Активны: ${lists.ok.length}`,
  ].join("\n");

  for (let i = 0; i < report.length; i += 3500) {
    await sendMessage(env, msg.from.id, report.slice(i, i + 3500));
  }
}

async function handleAwardCommand(msg, env, text) {
  if (!isAdmin(msg.from.username, env)) return;
  const KINDS = ["visit_card", "sale_post", "online"];
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
