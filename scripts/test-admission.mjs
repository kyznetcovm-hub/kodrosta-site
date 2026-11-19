import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../src/index.js';
import { ensureAdmission } from '../src/admission.js';
import { parseAdmissionSheet, syncAdmissionRows } from '../src/admission-sync.js';
const TOKEN = 'test-only-bot-token', HOST_KEY = 'test-host-key-with-more-than-32-characters';
function admin(user = {id:1,username:'admin'}, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
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
  const env = { DB, BOT_TOKEN: TOKEN, ADMIN_USERNAMES: 'admin' };
  await ensureAdmission(env);
  sqlite.prepare("INSERT INTO admission_staff VALUES ('premiya-2026-demo',2,'Хостес','host','approved','2026-11-19',NULL,NULL)").run();
  for (const [id, status, event] of [['active','active','premiya-2026-demo'], ['pending','pending','premiya-2026-demo'], ['cancelled','cancelled','premiya-2026-demo'], ['other','active','other-event']])
    sqlite.prepare('INSERT INTO admission_tickets (id,event_id,token,person_name,company,category,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id,event, id.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a'), 'Тестовый гость', 'Тестовая компания', 'Гость',status,'2026-11-19T00:00:00Z');
  const tokens = Object.fromEntries(sqlite.prepare('SELECT id,token FROM admission_tickets').all().map(r => [r.id,r.token]));
  async function call(path, body, role = 'host') {
    const headers = typeof role === 'object' ? {authorization:admin(role)} : role === 'admin' ? { authorization: admin() } : role === 'host' ? { authorization:admin({id:2,username:'host'}) } : {};
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
test('Telegram: заявка, одобрение, вход без ключа и отзыв уже открытой сессии',async t=>{
 const {call,sqlite}=await fixture(t), user={id:3,username:'new_host',first_name:'Анна',last_name:'Тестовая'};
 assert.equal((await call('access',undefined,user)).body.state,'none');
 assert.equal((await call('tickets',undefined,user)).status,401);
 assert.equal((await call('access',{telegramId:1,state:'approved'},user)).body.state,'pending');
 assert.equal((await call('staff',undefined,user)).status,401);
 const list=await call('staff',undefined,'admin');assert.equal(list.body.staff[0].telegramId,3);
 assert.equal(list.body.staff[0].name,'Анна Тестовая');
 assert.equal((await call('staff',{telegramId:3,state:'approved'},'admin')).status,200);
 assert.equal((await call('me',undefined,user)).body.role,'host');
 assert.equal((await call('tickets',undefined,user)).body.tickets[0].token,undefined);
 assert.equal((await call('staff',{telegramId:2,state:'approved'},user)).status,403);
 assert.equal((await call('check-in',{id:'active'},user)).body.decision,'green');
 assert.equal(sqlite.prepare("SELECT checked_in_by FROM admission_tickets WHERE id='active'").get().checked_in_by,'host:3');
 await call('staff',{telegramId:3,state:'revoked'},'admin');
 assert.equal((await call('tickets',undefined,user)).status,401);
 assert.equal((await call('check-in',{id:'pending'},user)).status,401);
 assert.equal((await call('access',{},user)).body.state,'revoked');
 assert.equal((await call('staff',{telegramId:3,state:'approved'},'admin')).status,200);
 assert.equal((await call('me',undefined,{id:3,username:'changed_name'})).body.role,'host');
 assert.equal((await call('me',undefined,{id:4,username:'new_host'})).status,401);
});
test('Telegram: подмена ID, просроченная подпись и прежний общий ключ доступа не дают',async t=>{
 const {env,call}=await fixture(t);
 for (const headers of [
   {'x-admission-key':HOST_KEY},
   {authorization:admin({id:2,username:'host'}).replace('%22id%22%3A2','%22id%22%3A3')},
   {authorization:admin({id:2,username:'host'},Math.floor(Date.now()/1000)-25*3600)},
 ]) {
   const r=await worker.fetch(new Request('https://codrosta.club/api/admission/me',{headers}),env,{});assert.equal(r.status,401);
 }
 assert.equal((await call('access',{},'guest')).status,401);
 assert.equal((await call('host-access',undefined,'admin')).status,404);
 assert.equal((await call('staff',{telegramId:99,state:'approved'},'admin')).status,404);
 assert.equal((await call('staff',{telegramId:'2',state:'approved'},'admin')).status,400);
});
test('Telegram: допуск хостес ограничен событием и не даёт входа в офис',async t=>{
 const {env,call}=await fixture(t);
 const response=await worker.fetch(new Request('https://codrosta.club/api/office/me',{headers:{authorization:admin({id:2,username:'host'})}}),env,{});
 assert.equal(response.status,403);
 env.ADMISSION_EVENT_ID='another-event';
 assert.equal((await call('me')).status,401);
 assert.equal((await call('access',undefined,'host')).body.state,'none');
});

test('бот: прямая ссылка, /hostess и /menu открывают хостес без запроса телефона',async t=>{
 const {env}=await fixture(t), {handleTelegramUpdate}=await import('../src/engagement.js'), messages=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
   assert.match(String(url),/api\.telegram\.org/);messages.push(JSON.parse(options.body));return Response.json({ok:true});
 });
 for (const text of ['/start hostess','/hostess','/menu']) {
   await handleTelegramUpdate({message:{from:{id:3,first_name:'Хостес'},chat:{id:3,type:'private'},text}},env);
   const sent=messages.at(-1);assert.equal(sent.chat_id,3);
   assert.equal(sent.reply_markup.inline_keyboard[0][0].web_app.url,'https://codrosta.club/admission?mode=hostess');
   assert.equal(sent.reply_markup.keyboard,undefined);
 }
});

// UI исполняется вместе с настоящим Worker и SQLite; Telegram подменён только на границе SDK.
async function browserFixture(env,user,options={}) {
 const html=readFileSync(new URL('../admission.html',import.meta.url),'utf8'), nodes=new Map();
 function node() { return {hidden:false,textContent:'',value:'',children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){},scrollIntoView(){}}; }
 for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1],node());
 const drawn=[], canvasContext={fillRect(){},fillText(text){drawn.push(text);},measureText(text){return {width:text.length*16};},drawImage(){}};
 const document={hidden:false,getElementById(id){assert.ok(nodes.has(id),'реальный HTML содержит '+id);return nodes.get(id);},createElement(tag){const n=node();if(tag==='canvas'){n.getContext=()=>canvasContext;n.toDataURL=()=>'data:image/png;base64,dGVzdA==';}n.click=()=>{};return n;},addEventListener(){}};
 const sdk={initData:admin(user).slice(4),platform:'ios',ready(){},expand(){},isVersionAtLeast(){return true;},closeScanQrPopup(){},showScanQrPopup(_,callback){this.scan=callback;}};
 const context={document,window:{Telegram:{WebApp:sdk},qrcode(){return {addData(){},make(){},createDataURL(){return 'data:image/gif;base64,dGVzdA==';}};},addEventListener(){},confirm(){return true;}},Image:class {async decode(){}},sessionStorage:{removeItem(){}},location:new URL(options.url || 'https://codrosta.club/admission?mode=hostess'),URL,URLSearchParams,navigator:{},setInterval(){},fetch(url,options={}){return worker.fetch(new Request(new URL(url,'https://codrosta.club'),options),env,{});}};
 vm.runInNewContext(readFileSync(new URL('../js/admission.js',import.meta.url),'utf8'),context);
 async function settle(){for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));}
 await settle();return {nodes,sdk,settle,drawn};
}
test('экран хостес: запрос доступа, подтверждение организатором и вход одной кнопкой',async t=>{
 const {env,call}=await fixture(t), ui=await browserFixture(env,{id:3,first_name:'Анна'});
 assert.equal(ui.nodes.get('access-panel').hidden,false);assert.equal(ui.nodes.get('request-access').hidden,false);
 await ui.nodes.get('request-access').onclick();assert.equal(ui.nodes.get('request-access').hidden,true);
 assert.match(ui.nodes.get('access-message').textContent,/Заявка отправлена/);
 await call('staff',{telegramId:3,state:'approved'},'admin');await ui.nodes.get('retry-access').onclick();
 assert.equal(ui.nodes.get('login').hidden,true);assert.equal(ui.nodes.get('scan-panel').hidden,false);
 assert.equal(ui.nodes.get('sheet-sync').hidden,true);assert.equal(ui.nodes.get('staff-panel').hidden,true);
});
test('сканер Telegram: проверяет тестовый QR и игнорирует повторный callback камеры',async t=>{
 const {env,tokens,sqlite}=await fixture(t), ui=await browserFixture(env,{id:2,username:'host'});
 await ui.nodes.get('start-camera').onclick();const callback=ui.sdk.scan;assert.equal(typeof callback,'function');
 assert.equal(callback('https://foreign.example/admission#t='+tokens.active),false);
 assert.equal(callback('https://codrosta.club/admission?view=ticket#t='+tokens.active),true);
 assert.equal(callback('https://codrosta.club/admission#t='+tokens.active),true);
 await ui.settle();assert.equal(ui.nodes.get('decision').className,'decision green');
 assert.equal(sqlite.prepare("SELECT checked_in_by FROM admission_tickets WHERE id='active'").get().checked_in_by,'host:2');
 await ui.nodes.get('start-camera').onclick();ui.sdk.scan('https://codrosta.club/admission#t='+tokens.active);
 await ui.settle();assert.equal(ui.nodes.get('decision').className,'decision red');
});
test('приглашение: четыре купленных пакета на странице и в PNG, обязательные сведения и просмотр без прохода',async t=>{
 const {env,sqlite,tokens}=await fixture(t);
 for(const [tariff,expected] of [['Гость','Премия'],['Гость + игра','Премия + игра'],['Гость + подкаст','Премия + подкаст'],['Гость + игра + подкаст','Премия + игра + подкаст']]) {
   sqlite.prepare("UPDATE admission_tickets SET category=? WHERE id='active'").run(tariff);
   const ui=await browserFixture(env,{id:2},{url:'https://codrosta.club/admission?view=ticket#t='+tokens.active});
   assert.equal(ui.nodes.get('ticket-category').textContent,expected);
   ui.nodes.get('save-ticket').onclick();await ui.settle();
   for(const text of [expected,'27 ноября 2026 · Начало в 18:30','ЦУМ · ул. Московская, 2','Дресс-код — коктейльный','Telegram: @Kodrosta · t.me/Kodrosta']) assert.ok(ui.drawn.includes(text),text);
 }
 assert.equal(sqlite.prepare("SELECT checked_in_at FROM admission_tickets WHERE id='active'").get().checked_in_at,null);
});
