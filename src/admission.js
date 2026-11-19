// Персональные билеты премии. Просмотр билета никогда не регистрирует проход.
// Администратор: существующий вход Telegram. Хостес: отдельный секрет события.
import { authenticate } from './office.js';

export const ADMISSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admission_tickets (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    person_name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','active','cancelled')),
    checked_in_at TEXT, checked_in_by TEXT, created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS admission_event ON admission_tickets(event_id)',
];
const ready = new WeakMap();
export function ensureAdmission(env) {
  if (!ready.has(env.DB)) ready.set(env.DB, (async () => {
    for (const sql of ADMISSION_SCHEMA) await env.DB.prepare(sql).run();
  })().catch(err => { ready.delete(env.DB); throw err; }));
  return ready.get(env.DB);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  } });
}
export function admissionEvent(env) {
  return { id: env.ADMISSION_EVENT_ID || 'premiya-2026-demo',
    name: 'Живой код · Предприниматель года', date: '27 ноября 2026',
    place: 'Центр уникального мастерства · Казань',
    demo: !env.ADMISSION_EVENT_ID || env.ADMISSION_EVENT_ID.endsWith('-demo') };
}
function publicTicket(t) {
  return { id: t.id, name: t.person_name, company: t.company, category: t.category,
    status: t.status, checkedInAt: t.checked_in_at };
}
function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
async function sameSecret(a, b) {
  if (!a || !b || b.length < 32 || a.length > 256) return false;
  const hash = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let diff = 0;
  const aa = new Uint8Array(x), bb = new Uint8Array(y);
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
async function access(request, env) {
  if (await sameSecret(request.headers.get('x-admission-key'), env.ADMISSION_HOST_KEY))
    return { role: 'host', actor: 'host' };
  const auth = await authenticate(request, env);
  return auth.user ? { role: 'admin', actor: 'admin:' + auth.user.id } : null;
}
const categories = ['Гость', 'Резидент', 'Номинант', 'Партнёр', 'VIP'];
export async function handleAdmissionApi(request, env, path) {
  try {
    if (!env.DB) return json({ error: 'База билетов не подключена' }, 503);
    const event = admissionEvent(env);
    let body = {};
    if (request.method === 'POST') {
      if (Number(request.headers.get('content-length') || 0) > 4096)
        return json({ error: 'Слишком большой запрос' }, 413);
      const raw = await request.text();
      if (raw.length > 4096) return json({ error: 'Слишком большой запрос' }, 413);
      try { body = JSON.parse(raw); } catch { return json({ error: 'Некорректный запрос' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Некорректный запрос' }, 400);
    }
    // Секрет билета передаётся в теле POST, не в URL запроса или журнале переходов.
    if (path === '/api/admission/ticket' && request.method === 'POST') {
      if (!/^[a-f0-9]{64}$/.test(body.token || '')) return json({ error: 'Билет не найден' }, 404);
      await ensureAdmission(env);
      const ticket = await env.DB.prepare('SELECT * FROM admission_tickets WHERE event_id = ? AND token = ?')
        .bind(event.id, body.token).first();
      return ticket ? json({ event, ticket: publicTicket(ticket) }) : json({ error: 'Билет не найден' }, 404);
    }
    const user = await access(request, env);
    if (!user) return json({ error: 'Нужен доступ организатора или хостес' }, 401);
    await ensureAdmission(env);
    if (path === '/api/admission/me' && request.method === 'GET') return json({ event, role: user.role });
    if (path === '/api/admission/tickets' && request.method === 'GET') {
      const rows = (await env.DB.prepare('SELECT * FROM admission_tickets WHERE event_id = ? ORDER BY created_at, id')
        .bind(event.id).all()).results;
      return json({ event, tickets: rows.map(t => ({ ...publicTicket(t), ...(user.role === 'admin' ? { token: t.token } : {}) })),
        stats: { total: rows.length, admitted: rows.filter(t => t.checked_in_at).length,
          expected: rows.filter(t => t.status === 'active' && !t.checked_in_at).length } });
    }
    if (path === '/api/admission/create' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Только организатор может выпускать билеты' }, 403);
      const name = String(body.name || '').trim(), company = String(body.company || '').trim();
      if (name.length < 2 || name.length > 120 || company.length > 160 || !categories.includes(body.category))
        return json({ error: 'Проверь имя, компанию и категорию гостя' }, 400);
      const id = crypto.randomUUID(), token = randomToken();
      await env.DB.prepare(`INSERT INTO admission_tickets (id,event_id,token,person_name,company,category,status,created_at)
        VALUES (?,?,?,?,?,?,'pending',?)`).bind(id, event.id, token, name, company, body.category, new Date().toISOString()).run();
      return json({ id }, 201);
    }
    if (path === '/api/admission/status' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Только организатор может менять билет' }, 403);
      if (!['active', 'cancelled'].includes(body.status)) return json({ error: 'Некорректный статус' }, 400);
      const result = await env.DB.prepare('UPDATE admission_tickets SET status = ? WHERE id = ? AND event_id = ?')
        .bind(body.status, String(body.id || ''), event.id).run();
      return result.meta.changes ? json({ ok: true }) : json({ error: 'Билет не найден' }, 404);
    }
    if (path === '/api/admission/check-in' && request.method === 'POST') {
      const token = String(body.token || ''), id = String(body.id || '');
      if (!(token && /^[a-f0-9]{64}$/.test(token)) && !(id && /^[\w-]{1,64}$/.test(id)))
        return json({ decision: 'red', reason: 'Билет не найден' });
      const field = token ? 'token' : 'id', value = token || id;
      const at = new Date().toISOString();
      // Одна условная запись SQL: два одновременных сканирования не могут пройти оба.
      const changed = await env.DB.prepare(`UPDATE admission_tickets SET checked_in_at = ?, checked_in_by = ?
        WHERE event_id = ? AND ${field} = ? AND status = 'active' AND checked_in_at IS NULL
        RETURNING *`).bind(at, user.actor, event.id, value).first();
      if (changed) return json({ decision: 'green', reason: 'Проход зарегистрирован', ticket: publicTicket(changed) });
      const ticket = await env.DB.prepare(`SELECT * FROM admission_tickets WHERE event_id = ? AND ${field} = ?`)
        .bind(event.id, value).first();
      if (!ticket) return json({ decision: 'red', reason: 'Билет не найден' });
      const reason = ticket.status === 'cancelled' ? 'Билет отменён' : ticket.status === 'pending'
        ? 'Участие ещё не подтверждено' : 'Этот билет уже использован';
      return json({ decision: 'red', reason, ticket: publicTicket(ticket) });
    }
    return json({ error: 'Неизвестная операция' }, 404);
  } catch (err) {
    console.error('admission: сбой проверки билета', err?.name || 'Error');
    return json({ error: 'Проверка недоступна. Обратись к организатору.' }, 503);
  }
}
