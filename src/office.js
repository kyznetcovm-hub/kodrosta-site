// Серверная часть Mini App «Офис в кармане» (office.html, js/office.js).
//
// Вход — только через Telegram: Mini App, открытый из бота, получает от
// Telegram подписанную строку initData и шлёт её в каждом запросе заголовком
//   Authorization: tma <initData>
// Сервер проверяет подпись токеном бота (BOT_TOKEN) и срок, затем — что это
// один из админов бота. Без подписи, с подменённой или просроченной строкой,
// с чужого аккаунта данные не отдаются.
//
// Кто админ: числовой Telegram ID должен совпадать с chat_id, который бот
// сам сохранил для админа из ADMIN_USERNAMES (ensureAdminRegistered в
// engagement.js — при любом сообщении/кнопке админа). Только совпадения
// username недостаточно: ник можно сменить, и его может занять другой человек.
//
// Эндпоинты:
//   GET  /api/office/me         — кто вошёл ({ ok, user: { id, username, firstName } })
//   GET  /api/office/data       — данные экранов: события текущего месяца по Москве
//                                 (прошедшие) и все будущие, с регистрациями и планом
//   POST /api/office/event-plan — { eventId, plan } — план участников (null — снять)
//   GET  /api/office/money?month=YYYY-MM — деньги месяца (см. office-money.js)
//   POST /api/office/sales      — { clientId, date, amountKop, source, eventId?, comment? }
//   POST /api/office/sales/void — { id } — отменить запись (не удаляется)
//   POST /api/office/plans      — { month, sources: { new, renewal, events, ads }, weeks: [..] }
//
// Регистрации = записи на событие (бот, сайт, вручную, старые заявки с сайта)
// без повторов — та же функция, что «Список участников» в боте. Участники
// группы мероприятия не считаются: это состав чата, а не записи.

import { normalizeUsername, collectEventRegistrations } from "./engagement.js";
import { listEventsFrom, getEventById, setEventPlan, isTurizmEvent } from "./events-store.js";
import { getMonthMoney, addSale, voidSale, savePlans, isValidMonth } from "./office-money.js";

// initData живёт, пока открыт Mini App; сутки — с запасом на «открыл утром,
// смотрит вечером», и всё ещё не позволяет пользоваться утёкшей строкой вечно.
const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;

// Корпоративный аккаунт клуба — с него работает сотрудница, поэтому в
// приветствии не обращаемся по имени профиля («Код Роста, вот что…»).
const SHARED_ACCOUNTS = ["kodrosta"];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

// Проверка initData по алгоритму Telegram (core.telegram.org/bots/webapps,
// «Validating data received via the Mini App»):
//   secret = HMAC_SHA256(key = "WebAppData", msg = bot_token)
//   hash   = hex(HMAC_SHA256(key = secret, msg = data_check_string)),
// где data_check_string — все поля, кроме hash, «ключ=значение», по алфавиту,
// через \n. Возвращает пользователя Telegram или null.
export async function verifyInitData(initData, botToken, nowSec) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const checkString = Array.from(params.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const expected = toHex(await hmacSha256(secret, checkString));
  // сравнение без раннего выхода — время ответа не подсказывает, сколько символов совпало
  const got = hash.toLowerCase();
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff !== 0) return null;

  const authDate = Number(params.get("auth_date"));
  const now = nowSec != null ? nowSec : Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > INIT_DATA_MAX_AGE_SEC || authDate - now > 300) return null;

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (e) {
    return null;
  }
  if (!user || !Number.isInteger(user.id)) return null;
  return user;
}

// Админ бота с подтверждённым числовым ID (см. шапку файла).
async function isOfficeUser(env, tgUser) {
  const admins = String(env.ADMIN_USERNAMES || "").split(",").map(normalizeUsername).filter(Boolean);
  if (!admins.length || !env.DB) return false;
  const row = await env.DB.prepare("SELECT telegram_username FROM residents WHERE chat_id = ?").bind(tgUser.id).first();
  return !!(row && admins.includes(normalizeUsername(row.telegram_username)));
}

// Общая проверка для всех /api/office/*: { user } или { response } с ошибкой.
async function authenticate(request, env) {
  const auth = request.headers.get("authorization") || "";
  const initData = auth.startsWith("tma ") ? auth.slice(4) : "";
  if (!initData) return { response: json({ ok: false, error: "no_auth" }, 401) };
  if (!env.BOT_TOKEN) return { response: json({ ok: false, error: "not_configured" }, 500) };
  const user = await verifyInitData(initData, env.BOT_TOKEN);
  if (!user) return { response: json({ ok: false, error: "bad_auth" }, 401) };
  if (!(await isOfficeUser(env, user))) return { response: json({ ok: false, error: "forbidden" }, 403) };
  return { user };
}

function officeUser(user) {
  const username = normalizeUsername(user.username) || null;
  return { id: user.id, username, firstName: SHARED_ACCOUNTS.includes(username) ? null : user.first_name || null };
}

// Даты мероприятий в базе — московское время без пояса ("2026-10-08T18:00:00");
// в Москве нет перехода на летнее время, поэтому пояс всегда +03:00.
function withMoscowOffset(local) {
  if (!local) return null;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(local)) return local;
  return (local.length === 16 ? local + ":00" : local) + "+03:00";
}

function moscowMonth(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit" }).format(date).slice(0, 7);
}

const PLAN_MAX = 100000; // защита от опечатки, не бизнес-правило

async function handleData(env, user) {
  const now = new Date();
  const month = moscowMonth(now);
  const events = await listEventsFrom(env.DB, month + "-01T00:00:00");
  const out = [];
  for (const e of events) {
    const r = await collectEventRegistrations(env, e);
    out.push({
      id: e.id,
      title: e.title,
      format: e.tag || null,
      turizm: isTurizmEvent(e),
      start: withMoscowOffset(e.start),
      end: withMoscowOffset(e.end),
      registered: r.botNames.length + r.siteNames.length + r.manualNames.length,
      plan: e.plan,
    });
  }
  const money = await getMonthMoney(env.DB, month);
  return json({ ok: true, now: now.toISOString(), month, user: officeUser(user), events: out, money });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function result(r) {
  return r.ok ? json(r) : json(r, r.error === "not_found" ? 404 : 400);
}

async function handleEventPlan(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const eventId = body && typeof body.eventId === "string" ? body.eventId : "";
  const plan = body ? body.plan : undefined;
  if (!eventId) return json({ ok: false, error: "no_event" }, 400);
  if (plan !== null && !(Number.isInteger(plan) && plan > 0 && plan <= PLAN_MAX)) {
    return json({ ok: false, error: "bad_plan" }, 400);
  }
  const event = await getEventById(env.DB, eventId);
  if (!event) return json({ ok: false, error: "not_found" }, 404);
  await setEventPlan(env.DB, eventId, plan);
  return json({ ok: true, eventId, plan });
}

export async function handleOfficeApi(request, env, path) {
  const auth = await authenticate(request, env);
  if (auth.response) return auth.response;
  const user = auth.user;

  if (path === "/api/office/me" && request.method === "GET") {
    return json({ ok: true, user: officeUser(user) });
  }

  if (path === "/api/office/data" && request.method === "GET") {
    return handleData(env, user);
  }

  if (path === "/api/office/event-plan" && request.method === "POST") {
    return handleEventPlan(request, env);
  }

  if (path === "/api/office/money" && request.method === "GET") {
    const month = new URL(request.url).searchParams.get("month");
    if (!isValidMonth(month)) return json({ ok: false, error: "bad_month" }, 400);
    return json({ ok: true, money: await getMonthMoney(env.DB, month) });
  }

  if (path === "/api/office/sales" && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "bad_json" }, 400);
    return result(await addSale(env.DB, body, user));
  }

  if (path === "/api/office/sales/void" && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "bad_json" }, 400);
    return result(await voidSale(env.DB, body.id, user));
  }

  if (path === "/api/office/plans" && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "bad_json" }, 400);
    return result(await savePlans(env.DB, body.month, body, user));
  }

  return json({ ok: false, error: "not_found" }, 404);
}
