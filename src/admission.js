// Персональные билеты премии. Просмотр билета никогда не регистрирует проход.
// Организатор и хостес входят по подписанному аккаунту Telegram.
import { authenticate, verifyInitData } from './office.js';
import { ADMISSION_SOURCE_SCHEMA, ADMISSION_TARIFFS } from './admission-sync.js';
import { ADMISSION_WORKFLOW_SCHEMA, isAdmissionOwner, makeAdmissionRequest, decideAdmissionRequest, requestAdmissionAccess } from './admission-workflow.js';

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
    for (const sql of [...ADMISSION_SCHEMA, ADMISSION_SOURCE_SCHEMA, ...ADMISSION_WORKFLOW_SCHEMA]) await env.DB.prepare(sql).run();
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
  if (auth.user) return { role: 'admin', actor: 'admin:' + auth.user.id, telegramId:auth.user.id, tg:auth.user };
  const user = await telegramUser(request, env);
  if (!user) return null;
  await ensureAdmission(env);
  const staff = await env.DB.prepare('SELECT state FROM admission_staff WHERE event_id=? AND telegram_id=?')
    .bind(admissionEvent(env).id,user.id).first();
  return staff?.state === 'approved' ? {role:'host',actor:'host:' + user.id,telegramId:user.id,tg:user} : null;
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
      if (!tg) return json({error:'Открой систему билетов через Telegram-бота.'},401);
      await ensureAdmission(env);
      if (request.method === 'POST') {
        try { await requestAdmissionAccess(env,tg); }
        catch(err) { return json({error:err.message},503); }
      }
      const staff = await env.DB.prepare('SELECT state FROM admission_staff WHERE event_id=? AND telegram_id=?').bind(event.id,tg.id).first();
      const pending = await env.DB.prepare("SELECT notified_at FROM admission_requests WHERE event_id=? AND kind='access' AND telegram_id=? AND state='pending'").bind(event.id,tg.id).first();
      return json({state:staff?.state || 'none',notificationPending:!!pending && !pending.notified_at});
    }
    const user = await access(request, env);
    if (!user) return json({ error: 'Нужен подтверждённый доступ к системе билетов' }, 401);
    await ensureAdmission(env);
    const owner = await isAdmissionOwner(env,user.telegramId);
    if (path === '/api/admission/me' && request.method === 'GET') return json({ event, role: user.role, canApprove:owner });
    if (path === '/api/admission/staff' && ['GET','POST'].includes(request.method)) {
      if (!owner) return json({error:'Только Михаил управляет доступом'},403);
      if (request.method === 'POST') {
        if (!Number.isSafeInteger(body.telegramId) || body.telegramId <= 0 || !['approved','revoked'].includes(body.state))
          return json({error:'Проверь сотрудника и действие'},400);
        const pending = await env.DB.prepare("SELECT id FROM admission_requests WHERE event_id=? AND kind='access' AND telegram_id=? AND state='pending'").bind(event.id,body.telegramId).first();
        if (pending) return json(await decideAdmissionRequest(env,pending.id,body.state === 'approved',user.telegramId));
        const result = await env.DB.prepare('UPDATE admission_staff SET state=?,decided_at=?,decided_by=? WHERE event_id=? AND telegram_id=?')
          .bind(body.state,new Date().toISOString(),user.actor,event.id,body.telegramId).run();
        return result.meta.changes ? json({ok:true}) : json({error:'Заявка сотрудника не найдена'},404);
      }
      const staff = (await env.DB.prepare(`SELECT telegram_id AS telegramId,person_name AS name,username,state FROM admission_staff
        WHERE event_id=? ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,requested_at`).bind(event.id).all()).results;
      return json({staff});
    }
    if (path === '/api/admission/sync' && request.method === 'POST') {
      return json({error:'Оплаты подтверждаются Михаилом в боте. Обновление из таблицы отключено.'},410);
    }
    if (path === '/api/admission/requests' && ['GET','POST'].includes(request.method)) {
      if (!owner) return json({error:'Только Михаил подтверждает заявки'},403);
      if (request.method === 'POST') {
        if (!/^[a-f0-9]{32}$/.test(body.id || '') || typeof body.approve !== 'boolean') return json({error:'Некорректная заявка'},400);
        const result = await decideAdmissionRequest(env,body.id,body.approve,user.telegramId);
        return json(result,result.ok ? 200 : 409);
      }
      const requests = (await env.DB.prepare(`SELECT r.id,r.kind,r.person_name AS manager,r.telegram_id AS telegramId,r.amount_kopeks AS amountKopeks,r.comment,
        t.person_name AS guest,t.category FROM admission_requests r LEFT JOIN admission_tickets t ON t.id=r.ticket_id
        WHERE r.event_id=? AND r.state='pending' ORDER BY r.created_at`).bind(event.id).all()).results;
      return json({requests});
    }
    if (path === '/api/admission/tickets' && request.method === 'GET') {
      const rows = (await env.DB.prepare('SELECT t.*,s.source_id FROM admission_tickets t LEFT JOIN admission_sheet_tickets s ON s.ticket_id=t.id WHERE t.event_id = ? ORDER BY t.created_at,t.id')
        .bind(event.id).all()).results;
      const requests = (await env.DB.prepare("SELECT ticket_id,state,notified_at FROM admission_requests WHERE event_id=? AND kind='payment' ORDER BY created_at,rowid").bind(event.id).all()).results;
      const payment = new Map(requests.map(r=>[r.ticket_id,r]));
      return json({ event, tickets: rows.map(t => ({ ...publicTicket(t),
        expectedRub:(ADMISSION_TARIFFS[t.category] || 0)/100,paymentState:payment.get(t.id)?.state || null,
        notificationPending:payment.get(t.id)?.state === 'pending' && !payment.get(t.id)?.notified_at,
        ...(owner ? {sourceId:t.source_id || null} : {}) })),
        stats: { total: rows.length, admitted: rows.filter(t => t.checked_in_at).length,
          expected: rows.filter(t => t.status === 'active' && !t.checked_in_at).length } });
    }
    if (path === '/api/admission/share' && request.method === 'POST') {
      const ticket = await env.DB.prepare('SELECT * FROM admission_tickets WHERE id=? AND event_id=?').bind(String(body.id || ''),event.id).first();
      if (!ticket || ticket.status !== 'active') return json({error:'Билет можно отправить только после подтверждения оплаты Михаилом'},403);
      return json({url:'https://codrosta.club/admission?view=ticket#t=' + ticket.token,
        message:ticket.person_name + ', оплата подтверждена! Твой билет на премию «Предприниматель года».\n27 ноября, 18:30 · ЦУМ, ул. Московская, 2.\nСохрани приглашение и покажи QR-код на входе. Дресс-код — коктейльный. Вопросы: @Kodrosta.'});
    }
    if (path === '/api/admission/payment-request' && request.method === 'POST') {
      const ticket = await env.DB.prepare('SELECT * FROM admission_tickets WHERE id=? AND event_id=?').bind(String(body.id || ''),event.id).first();
      if (!ticket || ticket.status !== 'pending') return json({error:'Оплату можно заявить для гостя, ожидающего оплаты'},409);
      const expected = ADMISSION_TARIFFS[ticket.category], amount = Number(body.amountRub), comment = String(body.comment || '').trim();
      if (!expected || typeof body.amountRub !== 'number' || !Number.isFinite(amount) || amount*100 < expected || amount >= 100000000 || Math.abs(amount*100-Math.round(amount*100))>0.00001 || comment.length>400)
        return json({error:'Укажи полную сумму оплаты и комментарий до 400 символов'},400);
      try { await makeAdmissionRequest(env,{kind:'payment',user:user.tg,ticketId:ticket.id,amount:Math.round(amount*100),comment}); }
      catch(err) { return json({error:err.message},503); }
      return json({ok:true});
    }
    if (path === '/api/admission/create' && request.method === 'POST') {
      const name = String(body.name || '').trim(), company = String(body.company || '').trim();
      const categoryOk = Object.hasOwn(ADMISSION_TARIFFS,body.category) || owner && categories.includes(body.category);
      if (name.length < 2 || name.length > 120 || company.length > 160 || !categoryOk)
        return json({ error: 'Проверь имя, компанию и категорию гостя' }, 400);
      const id = crypto.randomUUID(), token = randomToken();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO admission_tickets (id,event_id,token,person_name,company,category,status,created_at)
          VALUES (?,?,?,?,?,?,'pending',?)`).bind(id, event.id, token, name, company, body.category, new Date().toISOString()),
        env.DB.prepare('INSERT INTO admission_ticket_details (ticket_id,created_by,created_name,expected_kopeks) VALUES (?,?,?,?)')
          .bind(id,user.telegramId,user.tg.first_name || 'Менеджер',ADMISSION_TARIFFS[body.category] || 0),
      ]);
      return json({ id }, 201);
    }
    if (path === '/api/admission/status' && request.method === 'POST') {
      if (!owner) return json({ error: 'Только Михаил может подтверждать оплату или отменять билет' }, 403);
      if (!['active', 'cancelled'].includes(body.status)) return json({ error: 'Некорректный статус' }, 400);
      const source = await env.DB.prepare('SELECT source_id FROM admission_sheet_tickets WHERE ticket_id=? AND event_id=?')
        .bind(String(body.id || ''),event.id).first();
      if (source && body.status === 'active') return json({ error:'Сообщи об оплате через бота для подтверждения Михаилом.' },409);
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
