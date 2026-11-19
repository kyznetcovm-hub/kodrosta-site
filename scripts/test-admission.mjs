import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { ensureAdmission } from '../src/admission.js';
import { parseAdmissionSheet, syncAdmissionRows } from '../src/admission-sync.js';
const TOKEN = 'test-only-bot-token', HOST_KEY = 'test-host-key-with-more-than-32-characters';
function admin() {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 1, username: 'admin' }) });
  const text = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k,v]) => k + '=' + v).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(text).digest('hex')); return 'tma ' + p;
}
async function fixture(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE residents (telegram_username TEXT, chat_id INTEGER); INSERT INTO residents VALUES ('admin', 1)");
  const DB = { prepare(sql) { const st = sqlite.prepare(sql); let v = []; return { bind(...x) { v = x; return this; }, async first() { return st.get(...v) ?? null; }, async all() { return { results: st.all(...v) }; }, async run() { return { meta: { changes: Number(st.run(...v).changes) } }; } }; }, async batch(statements) {
    sqlite.exec('BEGIN'); try { for (const st of statements) await st.run(); sqlite.exec('COMMIT'); } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
  } };
  const env = { DB, BOT_TOKEN: TOKEN, ADMIN_USERNAMES: 'admin', ADMISSION_HOST_KEY: HOST_KEY };
  await ensureAdmission(env);
  for (const [id, status, event] of [['active','active','premiya-2026-demo'], ['pending','pending','premiya-2026-demo'], ['cancelled','cancelled','premiya-2026-demo'], ['other','active','other-event']])
    sqlite.prepare('INSERT INTO admission_tickets (id,event_id,token,person_name,company,category,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id,event, id.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a'), 'Тестовый гость', 'Тестовая компания', 'Гость',status,'2026-11-19T00:00:00Z');
  const tokens = Object.fromEntries(sqlite.prepare('SELECT id,token FROM admission_tickets').all().map(r => [r.id,r.token]));
  async function call(path, body, role = 'host') {
    const headers = role === 'admin' ? { authorization: admin() } : role === 'host' ? { 'x-admission-key': HOST_KEY } : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await worker.fetch(new Request('https://codrosta.club/api/admission/' + path, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
    return { status: r.status, body: await r.json(), headers: r.headers };
  }
  return { call, tokens, sqlite, env };
}
test('две одновременные проверки: ровно один зелёный проход', async t => {
  const { call, tokens } = await fixture(t);
  const results = await Promise.all([call('check-in', { token: tokens.active }), call('check-in', { token: tokens.active })]);
  assert.deepEqual(results.map(r => r.body.decision).sort(), ['green','red']);
  assert.equal(results.find(r => r.body.decision === 'red').body.reason, 'Этот билет уже использован');
  const list = await call('tickets'); assert.equal(list.body.stats.admitted, 1); assert.equal(list.body.stats.expected, 0);
});
test('открытие приглашения не регистрирует проход и не раскрывает секреты', async t => {
  const { call, tokens } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const r = await call('ticket', { token: tokens.active }, 'guest');
    assert.equal(r.status, 200); assert.equal(r.body.ticket.checkedInAt, null);
    assert.equal(r.body.ticket.token, undefined); assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await call('check-in', { token: tokens.active })).body.decision, 'green');
});
test('нет входа без авторизации, нельзя выдать себя за организатора', async t => {
  const { call, tokens } = await fixture(t);
  for (const path of ['me','tickets']) assert.equal((await call(path, undefined, 'guest')).status, 401);
  assert.equal((await call('check-in', { token: tokens.active }, 'guest')).status, 401);
  assert.equal((await call('create', { name: 'Чужой гость', category: 'VIP' })).status, 403);
  assert.equal((await call('status', { id: 'active', status: 'cancelled' })).status, 403);
  assert.equal((await call('tickets')).body.tickets[0].token, undefined);
});
test('ожидающие, отменённые, неизвестные билеты и другое событие не проходят', async t => {
  const { call, tokens } = await fixture(t);
  for (const token of [tokens.pending, tokens.cancelled, tokens.other, '0'.repeat(64), 'invalid'])
    assert.equal((await call('check-in', { token })).body.decision, 'red');
  assert.equal((await call('ticket', { token: tokens.other }, 'guest')).status, 404);
});
test('выпуск, подтверждение, ручной вход и отмена сохраняют историю', async t => {
  const { call } = await fixture(t);
  const created = await call('create', { name: 'Новый гость', company: 'Компания', category: 'Номинант' }, 'admin');
  assert.equal(created.status, 201); const id = created.body.id;
  assert.equal((await call('check-in', { id })).body.reason, 'Участие ещё не подтверждено');
  assert.equal((await call('status', { id, status: 'active' }, 'admin')).status, 200);
  const admitted = await call('check-in', { id }); assert.equal(admitted.body.decision, 'green');
  await call('status', { id, status: 'cancelled' }, 'admin');
  assert.equal((await call('check-in', { id })).body.reason, 'Билет отменён');
  await call('status', { id, status: 'active' }, 'admin');
  const again = await call('check-in', { id }); assert.equal(again.body.decision, 'red');
  assert.equal(again.body.ticket.checkedInAt, admitted.body.ticket.checkedInAt);
});
test('вход по невалидному JSON, массиву или неверной категории не ломает сервер', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('create', [], 'admin')).status, 400);
  assert.equal((await call('create', { name: 'Гость', category: 'Неизвестная' }, 'admin')).status, 400);
});

const sheetHeader=['ID билета','Имя и фамилия','Компания','Telegram / телефон','Формат билета','К оплате, ₽','Получено, ₽','Статус оплаты','Дата оплаты','Осталось, ₽','Выпуск билета','Комментарий'];
const paidRow=()=>['KR26-001','Тестовый гость','Компания',null,'Гость',7000,7000,'Оплачено',46332,0,'К выпуску',null];
test('синхронизация: повтор не меняет QR и не сбрасывает проход',async t=>{
  const {env,sqlite,call}=await fixture(t), rows=[sheetHeader,paidRow()];
  assert.equal((await syncAdmissionRows(env,'premiya-2026-demo',rows)).created,1);
  const original=sqlite.prepare("SELECT t.* FROM admission_tickets t JOIN admission_sheet_tickets s ON s.ticket_id=t.id").get();
  assert.equal((await call('check-in',{token:original.token})).body.decision,'green');
  await syncAdmissionRows(env,'premiya-2026-demo',rows);
  const current=sqlite.prepare('SELECT * FROM admission_tickets WHERE id=?').get(original.id);
  assert.equal(current.token,original.token);assert.ok(current.checked_in_at);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admission_sheet_tickets').get().n,1);
  assert.equal((await call('check-in',{token:original.token})).body.decision,'red');
});
test('синхронизация: недоплата и отмена отзывают вход, ручной обход запрещён',async t=>{
  const {env,sqlite,call}=await fixture(t), row=paidRow();
  await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,row]);
  const ticket=sqlite.prepare("SELECT t.* FROM admission_tickets t JOIN admission_sheet_tickets s ON s.ticket_id=t.id").get();
  row[6]=5000;await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,row]);
  assert.equal((await call('check-in',{token:ticket.token})).body.decision,'red');
  assert.equal((await call('status',{id:ticket.id,status:'active'},'admin')).status,409);
  row[6]=7000;row[7]='Не оплачено';await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,row]);
  assert.equal((await call('check-in',{token:ticket.token})).body.reason,'Билет отменён');
});
test('синхронизация: формула «К выпуску» не заменяет статус, сумму и дату',async t=>{
  const {env,sqlite}=await fixture(t);
  for(const change of [r=>r[7]='Ожидаем оплаты',r=>r[5]=1,r=>r[6]=6000,r=>r[8]=null,r=>r[4]='Другой']){
    const row=paidRow();change(row);
    assert.equal((await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,row])).created,0);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admission_sheet_tickets').get().n,0);
});
test('синхронизация: пустые строки и пропавшие записи не удаляют билет',async t=>{
  const {env,sqlite}=await fixture(t);
  await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,paidRow()]);
  await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,['KR26-002']]);
  assert.equal(sqlite.prepare('SELECT t.status FROM admission_tickets t JOIN admission_sheet_tickets s ON s.ticket_id=t.id').get().status,'active');
  await assert.rejects(syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,paidRow(),paidRow()]),/Повторяется ID/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admission_sheet_tickets').get().n,1);
});
test('синхронизация: более старый запрос не отменяет свежую оплату',async t=>{
  const {env,sqlite}=await fixture(t),row=paidRow();
  await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,row],'2026-11-19T12:01:00Z');
  row[7]='Не оплачено';await syncAdmissionRows(env,'premiya-2026-demo',[sheetHeader,row],'2026-11-19T12:00:00Z');
  assert.equal(sqlite.prepare('SELECT t.status FROM admission_tickets t JOIN admission_sheet_tickets s ON s.ticket_id=t.id').get().status,'active');
});
test('парсер: четыре тарифа, перестановка столбцов и неверные даты',()=>{
  for(const [tariff,cost] of [['Гость',7000],['Гость + игра',10000],['Гость + подкаст',12000],['Гость + игра + подкаст',15000]]){
    const row=paidRow();row[4]=tariff;row[5]=cost;row[6]=cost;
    assert.ok(parseAdmissionSheet([sheetHeader,row])[0].eligible);
    assert.ok(parseAdmissionSheet([[...sheetHeader].reverse(),[...row].reverse()])[0].eligible);
  }
  const row=paidRow();row[8]='31.11.2026';assert.equal(parseAdmissionSheet([sheetHeader,row])[0].eligible,false);
  assert.throws(()=>parseAdmissionSheet([['Неверные заголовки']]),/заголовки/);
});
test('API синхронизации: только организатор; сбой источника не меняет базу',async t=>{
  const {env,call,sqlite}=await fixture(t);env.ADMISSION_READ_SHEET=async()=>[sheetHeader,paidRow()];
  assert.equal((await call('sync',{},'host')).status,403);
  assert.equal((await call('sync',{},'guest')).status,401);
  const r=await call('sync',{},'admin');assert.equal(r.status,200);assert.equal(r.body.report.created,1);
  env.ADMISSION_READ_SHEET=async()=>{throw new Error('Источник недоступен');};
  assert.equal((await call('sync',{},'admin')).status,503);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admission_sheet_tickets').get().n,1);
});
