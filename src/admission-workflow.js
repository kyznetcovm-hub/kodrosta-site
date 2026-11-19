// Заявки менеджеров и подтверждение оплаты Михаилом. Таблица Google в этом процессе не участвует.
export const ADMISSION_WORKFLOW_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admission_staff (
    event_id TEXT NOT NULL, telegram_id INTEGER NOT NULL, person_name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK(state IN ('pending','approved','revoked')),
    requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, PRIMARY KEY(event_id,telegram_id)
  )`,
  `CREATE TABLE IF NOT EXISTS admission_ticket_details (
    ticket_id TEXT PRIMARY KEY, created_by INTEGER NOT NULL, created_name TEXT NOT NULL,
    expected_kopeks INTEGER NOT NULL, approved_at TEXT, approved_by INTEGER, paid_kopeks INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS admission_requests (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','payment')),
    telegram_id INTEGER NOT NULL, person_name TEXT NOT NULL, ticket_id TEXT,
    amount_kopeks INTEGER, comment TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL, decided_at TEXT, decided_by INTEGER, decision_key TEXT,
    notified_at TEXT, notify_claimed_at TEXT, message_id INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS admission_one_pending_request ON admission_requests
    (event_id,kind,COALESCE(ticket_id,''),CASE WHEN kind='access' THEN telegram_id ELSE 0 END) WHERE state='pending'`,
];
const ready = new WeakMap();
export function ensureAdmissionWorkflow(env) {
  if (!ready.has(env.DB)) ready.set(env.DB,(async()=>{for (const sql of ADMISSION_WORKFLOW_SCHEMA) await env.DB.prepare(sql).run();})().catch(err=>{ready.delete(env.DB);throw err;}));
  return ready.get(env.DB);
}
export function admissionWorkflowEvent(env) { return env.ADMISSION_EVENT_ID || 'premiya-2026-demo'; }
export async function admissionOwnerId(env) {
  const username = String(env.ADMISSION_OWNER_USERNAME || 'mytolstoy').replace(/^@/,'').toLowerCase();
  const row = await env.DB.prepare('SELECT chat_id FROM residents WHERE lower(telegram_username)=? AND chat_id>0').bind(username).first();
  return row ? Number(row.chat_id) : null;
}
export async function isAdmissionOwner(env, id) { return !!id && Number(id) === await admissionOwnerId(env); }
function escape(text) { return String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function telegram(env,method,body) {
  if (admissionWorkflowEvent(env).endsWith('-demo') && typeof env.ADMISSION_DEMO_TELEGRAM === 'function') return env.ADMISSION_DEMO_TELEGRAM(method,body);
  const response = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error('Telegram не подтвердил действие. Попробуй ещё раз.');
  return data.result;
}
export async function notifyAdmissionOwner(env, requestId) {
  const owner = await admissionOwnerId(env);
  if (!owner) throw new Error('Михаилу нужно открыть бота со своего аккаунта, чтобы получать заявки.');
  const now = new Date().toISOString(), expired = new Date(Date.now()-60000).toISOString();
  const request = await env.DB.prepare(`UPDATE admission_requests SET notify_claimed_at=? WHERE id=? AND state='pending'
    AND notified_at IS NULL AND (notify_claimed_at IS NULL OR notify_claimed_at<?) RETURNING *`).bind(now,requestId,expired).first();
  if (!request) return;
  try {
    let text, yes, no;
    if (request.kind === 'access') {
      const staff = await env.DB.prepare('SELECT username FROM admission_staff WHERE event_id=? AND telegram_id=?').bind(request.event_id,request.telegram_id).first();
      text = '🔐 <b>Доступ к билетам премии</b>\n' + escape(request.person_name)
        + (staff?.username ? ' (@' + escape(staff.username) + ')' : '') + '\nTelegram ID: ' + request.telegram_id
        + '\n\nРазрешить добавлять гостей, отправлять оплаченные билеты и проверять вход?';
      yes = 'Да'; no = 'Нет';
    } else {
      const ticket = await env.DB.prepare('SELECT person_name,company,category FROM admission_tickets WHERE id=? AND event_id=?').bind(request.ticket_id,request.event_id).first();
      if (!ticket) throw new Error('Гость не найден.');
      text = '💳 <b>Подтверждение оплаты билета</b>\nГость: ' + escape(ticket.person_name)
        + '\nКомпания: ' + escape(ticket.company) + '\nПакет: ' + escape(ticket.category.replace(/^Гость/,'Премия'))
        + '\nМенеджер: ' + escape(request.person_name) + '\nЗаявленная оплата: ' + (request.amount_kopeks/100).toLocaleString('ru-RU') + ' ₽'
        + (request.comment ? '\nКомментарий: ' + escape(request.comment) : '')
        + '\n\nПроверь поступление денег. Кнопка подтверждает полный расчёт и открывает билет для отправки.';
      yes = 'Оплата прошла'; no = 'Не подтверждаю';
    }
    // 128-битный одноразовый ID не отдаётся менеджеру; кнопки получает только владелец.
    const result = await telegram(env,'sendMessage',{chat_id:owner,text,parse_mode:'HTML',reply_markup:{inline_keyboard:[[
      {text:yes,callback_data:'adm:y:' + request.id},{text:no,callback_data:'adm:n:' + request.id},
    ]]}});
    await env.DB.prepare('UPDATE admission_requests SET notified_at=?,message_id=?,notify_claimed_at=NULL WHERE id=?')
      .bind(new Date().toISOString(),result?.message_id || null,request.id).run();
  } catch (err) {
    await env.DB.prepare('UPDATE admission_requests SET notify_claimed_at=NULL WHERE id=?').bind(request.id).run();
    throw new Error('Не удалось доставить заявку Михаилу. Заявка сохранена: нажми ещё раз для повторной отправки.');
  }
}
export async function makeAdmissionRequest(env, {kind,user,ticketId=null,amount=null,comment=''}) {
  const eventId = admissionWorkflowEvent(env), id = crypto.randomUUID().replace(/-/g,''), now = new Date().toISOString();
  const name = [user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,120) || 'Telegram ID ' + user.id;
  await env.DB.prepare(`INSERT OR IGNORE INTO admission_requests
    (id,event_id,kind,telegram_id,person_name,ticket_id,amount_kopeks,comment,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,'pending',?)`).bind(id,eventId,kind,user.id,name,ticketId,amount,comment,now).run();
  const request = await env.DB.prepare(`SELECT id FROM admission_requests WHERE event_id=? AND kind=? AND state='pending'
    AND COALESCE(ticket_id,'')=? AND (?='payment' OR telegram_id=?)`).bind(eventId,kind,ticketId || '',kind,user.id).first();
  await notifyAdmissionOwner(env,request.id);
}
export async function requestAdmissionAccess(env,user) {
  await ensureAdmissionWorkflow(env);
  const name = [user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,120) || 'Telegram ID ' + user.id;
  await env.DB.prepare(`INSERT INTO admission_staff (event_id,telegram_id,person_name,username,state,requested_at)
    VALUES (?,?,?,?,'pending',?) ON CONFLICT(event_id,telegram_id) DO UPDATE
    SET person_name=excluded.person_name,username=excluded.username,
    state=CASE WHEN admission_staff.state='approved' THEN 'approved' ELSE 'pending' END`)
    .bind(admissionWorkflowEvent(env),user.id,name,String(user.username || '').slice(0,64),new Date().toISOString()).run();
  const staff = await env.DB.prepare('SELECT state FROM admission_staff WHERE event_id=? AND telegram_id=?').bind(admissionWorkflowEvent(env),user.id).first();
  if (staff.state !== 'approved') await makeAdmissionRequest(env,{kind:'access',user});
}
export async function sendAdmissionEntry(env,user) {
  await ensureAdmissionWorkflow(env);
  const staff = await env.DB.prepare('SELECT state FROM admission_staff WHERE event_id=? AND telegram_id=?').bind(admissionWorkflowEvent(env),user.id).first();
  const allowed = await isAdmissionOwner(env,user.id) || staff?.state === 'approved';
  // Корпоративный администратор уже имеет прежний доступ к билетам, но оплаты подтверждает только Михаил.
  const adminNames = String(env.ADMIN_USERNAMES || '').toLowerCase().split(',').map(x=>x.trim());
  const resident = await env.DB.prepare('SELECT telegram_username FROM residents WHERE chat_id=?').bind(user.id).first();
  const admin = resident && adminNames.includes(String(resident.telegram_username).toLowerCase());
  return telegram(env,'sendMessage',{chat_id:user.id,
    text:allowed || admin ? 'Система билетов премии: гости, отправка билетов и проверка входа.' : 'Для работы с билетами нужно подтверждение Михаила. Отправь запрос на авторизацию.',
    reply_markup:{inline_keyboard:[[allowed || admin ? {text:'🎟 Открыть систему билетов',web_app:{url:'https://codrosta.club/admission'}} : {text:'Запросить авторизацию',callback_data:'adm:request'}]]},
  });
}
export async function decideAdmissionRequest(env, id, approve, ownerId) {
  if (!await isAdmissionOwner(env,ownerId)) return {ok:false,error:'Только Михаил может подтверждать заявки'};
  const request = await env.DB.prepare('SELECT * FROM admission_requests WHERE id=? AND event_id=?').bind(id,admissionWorkflowEvent(env)).first();
  if (!request) return {ok:false,error:'Заявка не найдена или относится к другому событию'};
  if (request.state !== 'pending') return {ok:true,already:true,state:request.state};
  const now = new Date().toISOString(), state = approve ? 'approved' : 'rejected', decisionKey = crypto.randomUUID(), statements = [];
  // Решение и его последствия — одна транзакция. Два одновременных «Да/Нет» не могут примениться оба.
  statements.push(env.DB.prepare(`UPDATE admission_requests SET state=?,decided_at=?,decided_by=?,decision_key=?
    WHERE id=? AND state='pending' AND (?=0 OR kind='access' OR EXISTS(
      SELECT 1 FROM admission_tickets WHERE id=admission_requests.ticket_id AND event_id=admission_requests.event_id AND status!='cancelled'))`)
    .bind(state,now,ownerId,decisionKey,id,approve ? 1 : 0));
  if (request.kind === 'access') {
    statements.push(env.DB.prepare(`UPDATE admission_staff SET state=?,decided_at=?,decided_by=? WHERE event_id=? AND telegram_id=?
      AND EXISTS(SELECT 1 FROM admission_requests WHERE id=? AND decision_key=?)`)
      .bind(approve ? 'approved' : 'revoked',now,'owner:' + ownerId,request.event_id,request.telegram_id,id,decisionKey));
  } else if (approve) {
    const ticket = await env.DB.prepare('SELECT status FROM admission_tickets WHERE id=? AND event_id=?').bind(request.ticket_id,request.event_id).first();
    if (!ticket || ticket.status === 'cancelled') return {ok:false,error:'Билет отменён или не найден. Оплату подтвердить нельзя.'};
    statements.push(env.DB.prepare(`UPDATE admission_tickets SET status='active' WHERE id=? AND event_id=? AND status!='cancelled'
      AND EXISTS(SELECT 1 FROM admission_requests WHERE id=? AND decision_key=?)`).bind(request.ticket_id,request.event_id,id,decisionKey));
    statements.push(env.DB.prepare(`INSERT INTO admission_ticket_details
      (ticket_id,created_by,created_name,expected_kopeks,approved_at,approved_by,paid_kopeks)
      SELECT ?,?,?,?, ?,?,? WHERE EXISTS(SELECT 1 FROM admission_requests WHERE id=? AND decision_key=?)
      ON CONFLICT(ticket_id) DO UPDATE SET approved_at=excluded.approved_at,approved_by=excluded.approved_by,paid_kopeks=excluded.paid_kopeks`)
      .bind(request.ticket_id,request.telegram_id,request.person_name,request.amount_kopeks,now,ownerId,request.amount_kopeks,id,decisionKey));
  }
  await env.DB.batch(statements);
  const decided = await env.DB.prepare('SELECT state,decision_key FROM admission_requests WHERE id=?').bind(id).first();
  if (decided.decision_key !== decisionKey) return decided.state === 'pending' ? {ok:false,error:'Заявка больше не может быть подтверждена'} : {ok:true,already:true,state:decided.state};
  if (request.kind === 'access') {
    try { await telegram(env,'sendMessage',{chat_id:request.telegram_id,
      text:approve ? 'Михаил подтвердил доступ к билетам премии.' : 'Доступ пока не подтверждён. Можно подать заявку повторно.',
      reply_markup:{inline_keyboard:[[approve ? {text:'🎟 Открыть систему билетов',web_app:{url:'https://codrosta.club/admission'}} : {text:'Подать заявку ещё раз',callback_data:'adm:request'}]]},
    }); } catch (_) { /* Решение сохранено; вход через исходную ссылку остаётся доступен. */ }
  }
  return {ok:true,state};
}
export async function handleAdmissionCallback(cq,env) {
  if (cq.data === 'adm:request' || cq.data === 'adm:open') {
    if (!Number.isSafeInteger(cq.from?.id) || cq.from.id <= 0 || cq.message?.chat?.id !== cq.from.id) return true;
    await telegram(env,'answerCallbackQuery',{callback_query_id:cq.id});
    await ensureAdmissionWorkflow(env);
    if (cq.data === 'adm:open') { await sendAdmissionEntry(env,cq.from);return true; }
    try {
      await requestAdmissionAccess(env,cq.from);
      await telegram(env,'sendMessage',{chat_id:cq.from.id,text:'Заявка отправлена Михаилу. После подтверждения бот пришлёт кнопку входа.',reply_markup:{inline_keyboard:[[{text:'Проверить доступ',callback_data:'adm:open'}]]}});
    } catch(err) { await telegram(env,'sendMessage',{chat_id:cq.from.id,text:err.message,reply_markup:{inline_keyboard:[[{text:'Повторить отправку заявки',callback_data:'adm:request'}]]}}); }
    return true;
  }
  const match = /^adm:([yn]):([a-f0-9]{32})$/.exec(cq.data || '');
  if (!match) return false;
  await ensureAdmissionWorkflow(env);
  const ownerId = await admissionOwnerId(env);
  if (!ownerId || cq.from?.id !== ownerId || cq.message?.chat?.id !== ownerId) {
    await telegram(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Только Михаил может подтвердить заявку',show_alert:true});return true;
  }
  // Сначала Telegram должен подтвердить действительный callback. Сфабрикованный HTTP-апдейт не меняет базу.
  await telegram(env,'answerCallbackQuery',{callback_query_id:cq.id});
  const result = await decideAdmissionRequest(env,match[2],match[1] === 'y',ownerId);
  if (!result.ok) { await telegram(env,'sendMessage',{chat_id:ownerId,text:result.error});return true; }
  try { await telegram(env,'editMessageReplyMarkup',{chat_id:ownerId,message_id:cq.message.message_id,reply_markup:{inline_keyboard:[]}}); } catch (_) {}
  await telegram(env,'sendMessage',{chat_id:ownerId,text:result.already ? 'Эта заявка уже обработана.' : result.state === 'approved' ? 'Подтверждено. Менеджер увидит обновление в кабинете.' : 'Отказ сохранён. Менеджер может подать новую заявку.'});
  return true;
}
