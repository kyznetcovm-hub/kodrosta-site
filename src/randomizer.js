// Серверная часть Mini App «Рандомайзер» (randomizer.html, js/randomizer.js).
//
// Вход и права — те же, что у «Офиса в кармане» (authenticate в office.js):
// только админы бота, подпись Telegram initData.
//
// Эндпоинты:
//   GET  /api/randomizer/events                  — события для выбора (+ число участников)
//   GET  /api/randomizer/participants?eventId=…  — { participants: [{ name, username }] }
//   POST /api/randomizer/draw  { eventId, winners: 1|2|3 } — выбирает победителей
//                                                  на сервере и пишет в историю
//   GET  /api/randomizer/history                 — последние розыгрыши
//
// Участники = записи на событие из всех источников без повторов (та же функция,
// что «Список записавшихся» в боте). Телефоны наружу не отдаются никогда —
// только имя и @username. Победителей выбирает сервер (crypto.getRandomValues),
// а барабан на экране лишь показывает уже выбранный результат: так запись в
// истории совпадает с тем, что увидели участники.

import { normalizeUsername, collectEventRegistrations } from "./engagement.js";
import { listAllEvents, getEventById } from "./events-store.js";
import { authenticate, json } from "./office.js";

const MAX_WINNERS = 3;
const EVENTS_LIMIT = 40;
const HISTORY_LIMIT = 30;

async function ensureRaffleTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS raffles (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, event_title TEXT NOT NULL, " +
    "participants_count INTEGER NOT NULL, winners_json TEXT NOT NULL, drawn_by TEXT, created_at TEXT NOT NULL)"
  ).run();
}

// Участники события: { name, username } без телефона и без повторов по @нику.
export async function listParticipants(env, event) {
  const found = [];
  await collectEventRegistrations(env, event, function (display, residentId, username, person) {
    if (person) found.push(person);
    return display;
  });
  const seen = new Set();
  const out = [];
  for (const p of found) {
    const username = normalizeUsername(p.username) || null;
    const name = String(p.name || "").trim() || null;
    if (!username && !name) continue;
    const key = username ? "@" + username : "n:" + name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || "@" + username, username });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

// Целое случайное число в [0, n) без смещения.
function randomBelow(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}

export function pickWinners(participants, count) {
  const pool = participants.slice();
  const winners = [];
  for (let i = 0; i < count && pool.length; i++) {
    winners.push(pool.splice(randomBelow(pool.length), 1)[0]);
  }
  return winners;
}

async function handleEvents(env) {
  const nowIso = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 19); // московское время
  const all = await listAllEvents(env.DB);
  const upcoming = all.filter((e) => e.start >= nowIso);
  const past = all.filter((e) => e.start < nowIso).reverse();
  const picked = upcoming.concat(past).slice(0, EVENTS_LIMIT);
  const events = [];
  for (const e of picked) {
    const participants = await listParticipants(env, e);
    events.push({ id: e.id, title: e.title, start: e.start, upcoming: e.start >= nowIso, count: participants.length });
  }
  return json({ ok: true, events });
}

async function handleParticipants(env, url) {
  const event = await getEventById(env.DB, url.searchParams.get("eventId") || "");
  if (!event) return json({ ok: false, error: "not_found" }, 404);
  const participants = await listParticipants(env, event);
  return json({ ok: true, event: { id: event.id, title: event.title }, participants });
}

async function handleDraw(request, env, user) {
  let body = null;
  try { body = await request.json(); } catch (e) { /* ниже — bad_json */ }
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const count = body.winners;
  if (!Number.isInteger(count) || count < 1 || count > MAX_WINNERS) return json({ ok: false, error: "bad_winners" }, 400);
  const event = await getEventById(env.DB, typeof body.eventId === "string" ? body.eventId : "");
  if (!event) return json({ ok: false, error: "not_found" }, 404);
  const participants = await listParticipants(env, event);
  if (participants.length < count) return json({ ok: false, error: "not_enough", total: participants.length }, 400);

  const winners = pickWinners(participants, count);
  await ensureRaffleTable(env);
  const drawnBy = normalizeUsername(user.username) || String(user.id);
  const res = await env.DB.prepare(
    "INSERT INTO raffles (event_id, event_title, participants_count, winners_json, drawn_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(event.id, event.title, participants.length, JSON.stringify(winners), drawnBy, new Date().toISOString()).run();
  return json({ ok: true, id: res && res.meta ? res.meta.last_row_id || null : null, event: { id: event.id, title: event.title }, total: participants.length, winners });
}

async function handleHistory(env) {
  await ensureRaffleTable(env);
  const { results } = await env.DB.prepare(
    "SELECT id, event_id, event_title, participants_count, winners_json, drawn_by, created_at FROM raffles ORDER BY id DESC LIMIT ?"
  ).bind(HISTORY_LIMIT).all();
  const raffles = (results || []).map((r) => ({
    id: r.id,
    eventId: r.event_id,
    eventTitle: r.event_title,
    total: r.participants_count,
    winners: JSON.parse(r.winners_json),
    drawnBy: r.drawn_by,
    createdAt: r.created_at,
  }));
  return json({ ok: true, raffles });
}

export async function handleRandomizerApi(request, env, path) {
  const auth = await authenticate(request, env);
  if (auth.response) return auth.response;

  if (path === "/api/randomizer/events" && request.method === "GET") return handleEvents(env);
  if (path === "/api/randomizer/participants" && request.method === "GET") return handleParticipants(env, new URL(request.url));
  if (path === "/api/randomizer/draw" && request.method === "POST") return handleDraw(request, env, auth.user);
  if (path === "/api/randomizer/history" && request.method === "GET") return handleHistory(env);
  return json({ ok: false, error: "not_found" }, 404);
}
