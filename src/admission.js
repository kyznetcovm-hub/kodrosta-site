// Персональные билеты премии. Просмотр билета никогда не регистрирует проход.
// Организатор и хостес входят по подписанному аккаунту Telegram.
import { authenticate, verifyInitData } from './office.js';
import { ADMISSION_SOURCE_SCHEMA, syncAdmissionFromSheet } from './admission-sync.js';

export const ADMISSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admission_tickets (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    person_name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','active','cancelled')),
    checked_in_at TEXT, checked_in_by TEXT, created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS admission_event ON admission_tickets(event_id)',
  `CREATE TABLE IF NOT EXISTS admission_staff (
    event_id TEXT NOT NULL, telegram_id INTEGER NOT NULL,
    person_name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK(state IN ('pending','approved','revoked')),
    requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
    PRIMARY KEY(event_id,telegram_id)
  )`,
];
const ready = new WeakMap();
export function ensureAdmission(env) {
  if (!ready.has(env.DB)) ready.set(env.DB, (async () => {
    for (const sql of [...ADMISSION_SCHEMA, ADMISSION_SOURCE_SCHEMA]) await env.DB.prepare(sql).run();
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
async function telegramUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  return verifyInitData(auth.startsWith('tma ') ? auth.slice(4) : '', env.BOT_TOKEN);
}
async function access(request, env) {
  const auth = await authenticate(request, env);
  if (auth.user) return { role: 'admin', actor: 'admin:' + auth.user.id };
  const user = await telegramUser(request, env);
  if (!user) return null;
  await ensureAdmission(env);
  const staff = await env.DB.prepare('SELECT state FROM admission_staff WHERE event_id=? AND telegram_id=?')
    .bind(admissionEvent(env).id,user.id).first();
  return staff?.state === 'approved' ? {role:'host',actor:'host:' + user.id} : null;
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
    if (path === '/api/admission/access' && ['GET','POST'].includes(request.method)) {
      const tg = await telegramUser(request,env);
      if (!tg) return json({error:'Открой вход для хостес через Telegram-бота.'},401);
      await ensureAdmission(env);
      if (request.method === 'POST') {
        const name = [tg.first_name,tg.last_name].filter(Boolean).join(' ').slice(0,120) || 'Telegram ID ' + tg.id;
        await env.DB.prepare(`INSERT INTO admission_staff (event_id,telegram_id,person_name,username,state,requested_at)
          VALUES (?,?,?,?,'pending',?) ON CONFLICT(event_id,telegram_id) DO UPDATE
          SET person_name=excluded.person_name,username=excluded.username`)
          .bind(event.id,tg.id,name,String(tg.username || '').slice(0,64),new Date().toISOString()).run();
      }
      const staff = await env.DB.prepare('SELECT state FROM admission_staff WHERE event_id=? AND telegram_id=?').bind(event.id,tg.id).first();
      return json({state:staff?.state || 'none'});
    }
    const user = await access(request, env);
    if (!user) return json({ error: 'Нужен доступ организатора или хостес' }, 401);
    await ensureAdmission(env);
    if (path === '/api/admission/me' && request.method === 'GET') return json({ event, role: user.role,
      syncSource: env.ADMISSION_SOURCE_LABEL || 'Google-таблица оплат' });
    if (path === '/api/admission/staff' && ['GET','POST'].includes(request.method)) {
      if (user.role !== 'admin') return json({error:'Только организатор управляет командой входа'},403);
      if (request.method === 'POST') {
        if (!Number.isSafeInteger(body.telegramId) || body.telegramId <= 0 || !['approved','revoked'].includes(body.state))
          return json({error:'Проверь сотрудника и действие'},400);
        const result = await env.DB.prepare('UPDATE admission_staff SET state=?,decided_at=?,decided_by=? WHERE event_id=? AND telegram_id=?')
          .bind(body.state,new Date().toISOString(),user.actor,event.id,body.telegramId).run();
        return result.meta.changes ? json({ok:true}) : json({error:'Заявка сотрудника не найдена'},404);
      }
      const staff = (await env.DB.prepare(`SELECT telegram_id AS telegramId,person_name AS name,username,state FROM admission_staff
        WHERE event_id=? ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,requested_at`).bind(event.id).all()).results;
      return json({staff});
    }
    if (path === '/api/admission/sync' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Только организатор может обновлять оплаты' }, 403);
      try { return json({ ok:true, report:await syncAdmissionFromSheet(env,event.id) }); }
      catch (err) { return json({ error:err.message || 'Не удалось обновить оплаты. Билеты не изменены.' }, 503); }
    }
    if (path === '/api/admission/tickets' && request.method === 'GET') {
      const rows = (await env.DB.prepare('SELECT t.*,s.source_id FROM admission_tickets t LEFT JOIN admission_sheet_tickets s ON s.ticket_id=t.id WHERE t.event_id = ? ORDER BY t.created_at,t.id')
        .bind(event.id).all()).results;
      return json({ event, tickets: rows.map(t => ({ ...publicTicket(t), ...(user.role === 'admin' ? { token: t.token, sourceId:t.source_id || null } : {}) })),
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
      const source = await env.DB.prepare('SELECT source_id FROM admission_sheet_tickets WHERE ticket_id=? AND event_id=?')
        .bind(String(body.id || ''),event.id).first();
      if (source) return json({ error:'Этот билет управляется оплатой в таблице. Измени статус там и обнови список.' },409);
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
