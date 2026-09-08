// Записи на мероприятие, собранные ботом (не через сайт).
//
// Источники:
//   source='bot'    — человек перешёл по ссылке t.me/<бот>?start=e_<eventId>
//                     и нажал «Записаться». @username и имя берём из профиля
//                     Telegram, телефон — только если сам поделился контактом.
//   source='manual' — менеджер вручную добавил имена/@ники на карточке
//                     мероприятия (для тех, кто не жмёт ссылки).
//
// Заявки с САЙТА сюда НЕ пишутся — они по-прежнему в touches (kind='event_signup'),
// «Список участников» в engagement.js объединяет оба хранилища.

let signupTablesReady = false;

export async function ensureSignupTables(env) {
  if (signupTablesReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS event_signups (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "event_id TEXT NOT NULL, " +
    "source TEXT NOT NULL, " +            // bot | manual
    "tg_user_id INTEGER, " +
    "username TEXT, " +                    // без @, в нижнем регистре
    "person_name TEXT, " +
    "phone TEXT, " +                       // нормализованный, если поделился контактом
    "resident_id INTEGER, " +
    "created_at TEXT NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_event_signups_event ON event_signups(event_id)"
  ).run();
  // одна запись через бота на пару (мероприятие, пользователь) — повторный тап
  // по ссылке не плодит дубли
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_signups_bot ON event_signups(event_id, tg_user_id) WHERE tg_user_id IS NOT NULL"
  ).run();
  signupTablesReady = true;
}

// Запись через бота. Идемпотентна: повтор обновляет username/имя, не создаёт дубль.
// Возвращает { created: boolean } — была ли создана новая запись (для текста ответа).
export async function recordBotSignup(env, eventId, user, residentId) {
  await ensureSignupTables(env);
  const username = user.username ? String(user.username).toLowerCase() : null;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || null;
  const existing = await env.DB.prepare(
    "SELECT id FROM event_signups WHERE event_id = ? AND tg_user_id = ?"
  ).bind(eventId, user.id).first();
  if (existing) {
    await env.DB.prepare(
      "UPDATE event_signups SET username = ?, person_name = ?, resident_id = COALESCE(?, resident_id) WHERE id = ?"
    ).bind(username, name, residentId ?? null, existing.id).run();
    return { created: false };
  }
  await env.DB.prepare(
    "INSERT INTO event_signups (event_id, source, tg_user_id, username, person_name, resident_id, created_at) " +
    "VALUES (?, 'bot', ?, ?, ?, ?, ?)"
  ).bind(eventId, user.id, username, name, residentId ?? null, new Date().toISOString()).run();
  return { created: true };
}

// Телефон + возможная привязка к резиденту для уже созданной записи через бота.
export async function attachSignupPhone(env, eventId, tgUserId, phone, residentId) {
  await ensureSignupTables(env);
  await env.DB.prepare(
    "UPDATE event_signups SET phone = ?, resident_id = COALESCE(?, resident_id) " +
    "WHERE event_id = ? AND tg_user_id = ?"
  ).bind(phone || null, residentId ?? null, eventId, tgUserId).run();
}

// Ручное добавление менеджером. items: [{ name, username }]. Пропускает тех,
// кто уже добавлен вручную на это мероприятие (по username, а если его нет — по имени).
// Возвращает число реально добавленных.
export async function recordManualSignups(env, eventId, items) {
  await ensureSignupTables(env);
  const { results } = await env.DB.prepare(
    "SELECT username, person_name FROM event_signups WHERE event_id = ? AND source = 'manual'"
  ).bind(eventId).all();
  const haveUser = new Set((results || []).map((r) => (r.username || "").toLowerCase()).filter(Boolean));
  const haveName = new Set((results || []).map((r) => (r.person_name || "").trim().toLowerCase()).filter(Boolean));

  let added = 0;
  for (const it of items) {
    const u = it.username ? String(it.username).toLowerCase() : null;
    const n = it.name ? String(it.name).trim() : null;
    if (!u && !n) continue;
    if (u && haveUser.has(u)) continue;
    if (!u && n && haveName.has(n.toLowerCase())) continue;
    await env.DB.prepare(
      "INSERT INTO event_signups (event_id, source, username, person_name, created_at) VALUES (?, 'manual', ?, ?, ?)"
    ).bind(eventId, u, n, new Date().toISOString()).run();
    if (u) haveUser.add(u);
    if (!u && n) haveName.add(n.toLowerCase());
    added++;
  }
  return added;
}

// Все записи мероприятия из этого хранилища (bot + manual).
export async function listEventSignups(env, eventId) {
  await ensureSignupTables(env);
  const { results } = await env.DB.prepare(
    "SELECT source, tg_user_id, username, person_name, phone, resident_id FROM event_signups WHERE event_id = ? ORDER BY created_at ASC"
  ).bind(eventId).all();
  return results || [];
}
