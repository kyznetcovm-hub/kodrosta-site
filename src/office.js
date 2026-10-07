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
//   GET /api/office/me — кто вошёл ({ ok, user: { id, username, firstName } })

import { normalizeUsername } from "./engagement.js";

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

export async function handleOfficeApi(request, env, path) {
  const auth = await authenticate(request, env);
  if (auth.response) return auth.response;
  const user = auth.user;

  if (path === "/api/office/me" && request.method === "GET") {
    const username = normalizeUsername(user.username) || null;
    return json({
      ok: true,
      user: {
        id: user.id,
        username,
        firstName: SHARED_ACCOUNTS.includes(username) ? null : user.first_name || null,
      },
    });
  }

  return json({ ok: false, error: "not_found" }, 404);
}
