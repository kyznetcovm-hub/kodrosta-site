import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../src/index.js';
import { ensureAdmission } from '../src/admission.js';
import { parseAdmissionSheet, syncAdmissionRows } from '../src/admission-sync.js';
import { handleAdmissionCallback, decideAdmissionRequest } from '../src/admission-workflow.js';
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
  const DB = { prepare(sql) { const st = sqlite.prepare(sql); let v = []; return { bind(...x) { v = x; return this; }, async first() { return st.get(...v) ?? null; }, async all() { return { results: st.all(...v) }; }, run() { return { meta: { changes: Number(st.run(...v).changes) } }; } }; }, async batch(statements) {
    sqlite.exec('BEGIN'); try { for (const st of statements) st.run(); sqlite.exec('COMMIT'); } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
  } };
  const messages=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.match(String(url),/^https:\/\/api\.telegram\.org\//);messages.push({method:String(url).split('/').pop(),body:JSON.parse(options.body)});
    return Response.json({ok:true,result:{message_id:messages.length}});
  });
  const env = { DB, BOT_TOKEN: TOKEN, ADMIN_USERNAMES: 'admin', ADMISSION_OWNER_USERNAME:'admin' };
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
  return { call, tokens, sqlite, env, messages };
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
  assert.equal((await call('create', { name: 'Чужой гость', category: 'VIP' })).status, 400);
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
test('таблица исключена из рабочего процесса: старый API не меняет оплаты и QR',async t=>{
  const {env,call,sqlite}=await fixture(t);env.ADMISSION_READ_SHEET=async()=>[sheetHeader,paidRow()];
  assert.equal((await call('sync',{},'host')).status,410);
  assert.equal((await call('sync',{},'guest')).status,401);
  const r=await call('sync',{},'admin');assert.equal(r.status,410);
  env.ADMISSION_READ_SHEET=async()=>{throw new Error('Источник недоступен');};
  assert.equal((await call('sync',{},'admin')).status,410);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM admission_sheet_tickets').get().n,0);
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
 assert.equal((await call('access',{},user)).body.state,'pending');
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
   assert.equal(sent.reply_markup.inline_keyboard[0][0].callback_data,'adm:request');
   assert.equal(sent.reply_markup.keyboard,undefined);
 }
});

// UI исполняется вместе с настоящим Worker и SQLite; Telegram подменён только на границе SDK.
async function browserFixture(env,user,options={}) {
 const html=readFileSync(new URL('../admission.html',import.meta.url),'utf8'), nodes=new Map();
 function node() { return {hidden:false,textContent:'',value:'',children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){},scrollIntoView(){},querySelector(){return node();},reset(){}}; }
 for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1],node());
 const drawn=[], canvasContext={fillRect(){},fillText(text){drawn.push(text);},measureText(text){return {width:text.length*16};},drawImage(){}};
 const document={hidden:false,getElementById(id){assert.ok(nodes.has(id),'реальный HTML содержит '+id);return nodes.get(id);},createElement(tag){const n=node();if(tag==='canvas'){n.getContext=()=>canvasContext;n.toDataURL=()=>'data:image/png;base64,dGVzdA==';}n.click=()=>{};return n;},addEventListener(){}};
 const sdk={initData:admin(user).slice(4),platform:'ios',ready(){},expand(){},isVersionAtLeast(){return true;},closeScanQrPopup(){},showScanQrPopup(_,callback){this.scan=callback;}};
 const intervals=[];
 const context={document,window:{Telegram:{WebApp:sdk},qrcode(){return {addData(){},make(){},createDataURL(){return 'data:image/gif;base64,dGVzdA==';}};},addEventListener(){},confirm(){return true;}},Image:class {async decode(){}},FormData:class {constructor(form){return form.testEntries;}},sessionStorage:{removeItem(){}},location:new URL(options.url || 'https://codrosta.club/admission?mode=hostess'),URL,URLSearchParams,navigator:{},setInterval(fn,ms){intervals.push({fn,ms});},fetch(url,options={}){return worker.fetch(new Request(new URL(url,'https://codrosta.club'),options),env,{});}};
 vm.runInNewContext(readFileSync(new URL('../js/admission.js',import.meta.url),'utf8'),context);
 async function settle(){for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));}
 await settle();return {nodes,sdk,settle,drawn,intervals};
}
test('экран хостес: запрос доступа, подтверждение организатором и вход одной кнопкой',async t=>{
 const {env,call}=await fixture(t), ui=await browserFixture(env,{id:3,first_name:'Анна'});
 assert.equal(ui.nodes.get('access-panel').hidden,false);assert.equal(ui.nodes.get('request-access').hidden,false);
 await ui.nodes.get('request-access').onclick();assert.equal(ui.nodes.get('request-access').hidden,true);
 assert.match(ui.nodes.get('access-message').textContent,/Заявка отправлена/);
 await call('staff',{telegramId:3,state:'approved'},'admin');await ui.nodes.get('retry-access').onclick();
 assert.equal(ui.nodes.get('login').hidden,true);assert.equal(ui.nodes.get('scan-panel').hidden,false);
 assert.equal(ui.nodes.has('sheet-sync'),false);assert.equal(ui.nodes.get('staff-panel').hidden,true);
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

const callback = (id, data, chatId=id) => ({id:'telegram-fixture-query',from:{id,first_name:'Менеджер'},data,message:{message_id:123,chat:{id:chatId,type:'private'}}});
test('весь путь авторизации в боте: ничего лишнего до допуска, отказ, новая заявка и две кнопки только Михаилу',async t=>{
 const {env,call,sqlite,messages}=await fixture(t),{handleTelegramUpdate}=await import('../src/engagement.js');
 await handleTelegramUpdate({message:{from:{id:3,first_name:'Анна'},chat:{id:3,type:'private'},text:'/start tickets'}},env);
 const entry=messages.at(-1).body.reply_markup.inline_keyboard.flat();
 assert.deepEqual(entry,[{text:'Запросить авторизацию',callback_data:'adm:request'}]);
 assert.equal((await call('tickets',undefined,{id:3})).status,401);
 await handleAdmissionCallback(callback(3,'adm:request'),env);
 const first=sqlite.prepare("SELECT * FROM admission_requests WHERE kind='access'").get();
 const notice=messages.find(m=>m.method==='sendMessage'&&m.body.chat_id===1);
 assert.deepEqual(notice.body.reply_markup.inline_keyboard[0].map(b=>b.text),['Да','Нет']);
 assert.equal(JSON.stringify((await call('access',undefined,{id:3})).body).includes(first.id),false);
 await handleAdmissionCallback(callback(1,'adm:n:'+first.id),env);
 assert.equal((await call('access',undefined,{id:3})).body.state,'revoked');
 await handleAdmissionCallback(callback(3,'adm:request'),env);
 const second=sqlite.prepare("SELECT * FROM admission_requests WHERE kind='access' AND state='pending'").get();
 assert.notEqual(second.id,first.id);
 await handleAdmissionCallback(callback(1,'adm:y:'+first.id),env);
 assert.equal((await call('me',undefined,{id:3})).status,401);
 await handleAdmissionCallback(callback(1,'adm:y:'+second.id),env);
 assert.equal((await call('me',undefined,{id:3})).body.role,'host');
 assert.equal(messages.at(-2).method,'editMessageReplyMarkup');
});
test('менеджер добавляет гостя: до подтверждения нет ссылки, после кнопки «Оплата прошла» билет доступен всей команде',async t=>{
 const {env,call,sqlite,messages}=await fixture(t);
 const added=await call('create',{name:'Новый оплаченный гость',company:'Компания',category:'Гость + игра + подкаст'});
 assert.equal(added.status,201);const id=added.body.id;
 assert.equal((await call('share',{id})).status,403);
 assert.equal((await call('check-in',{id})).body.decision,'red');
 assert.equal((await call('payment-request',{id,amountRub:10000})).status,400);
 assert.equal((await call('payment-request',{id,amountRub:15000,comment:'Перевод от компании'})).status,200);
 const notice=messages.find(m=>m.method==='sendMessage'&&m.body.chat_id===1);
 assert.match(notice.body.text,/15.000/);assert.match(notice.body.text,/Перевод от компании/);
 const buttons=notice.body.reply_markup.inline_keyboard[0];assert.equal(buttons[0].text,'Оплата прошла');
 assert.equal((await call('share',{id})).status,403);
 const request=sqlite.prepare("SELECT * FROM admission_requests WHERE kind='payment'").get();
 assert.equal((await call('requests',{id:request.id,approve:true})).status,403);
 await handleAdmissionCallback(callback(1,buttons[0].callback_data),env);
 const shared=await call('share',{id});assert.equal(shared.status,200);assert.match(shared.body.url,/#t=[a-f0-9]{64}$/);
 const detail=sqlite.prepare('SELECT * FROM admission_ticket_details WHERE ticket_id=?').get(id);
 assert.equal(detail.created_by,2);assert.equal(detail.approved_by,1);assert.equal(detail.paid_kopeks,1500000);
 const before=detail.approved_at;await handleAdmissionCallback(callback(1,buttons[0].callback_data),env);
 assert.equal(sqlite.prepare('SELECT approved_at FROM admission_ticket_details WHERE ticket_id=?').get(id).approved_at,before);
 assert.equal((await call('tickets')).body.tickets.find(t=>t.id===id).token,undefined);
});
test('корпоративный администратор и менеджер не могут подтвердить оплату вместо Михаила',async t=>{
 const {env,call,sqlite}=await fixture(t);
 sqlite.prepare("INSERT INTO residents VALUES ('corporate',22)").run();env.ADMIN_USERNAMES='admin,corporate';
 const id=(await call('create',{name:'Гость на проверку',category:'Гость'})).body.id;
 await call('payment-request',{id,amountRub:7000});
 const request=sqlite.prepare("SELECT id FROM admission_requests WHERE kind='payment'").get();
 for(const user of [{id:2},{id:22,username:'corporate'},{id:99,username:'admin'}]) {
   const r=await decideAdmissionRequest(env,request.id,true,user.id);assert.equal(r.ok,false);
   await handleAdmissionCallback(callback(user.id,'adm:y:'+request.id),env);
   assert.equal((await call('share',{id})).status,403);
   assert.equal((await call('status',{id,status:'active'},user)).status,user.id===99 ? 401 : 403);
 }
 assert.equal((await call('me',undefined,{id:22,username:'corporate'})).body.canApprove,false);
});
test('отклонённая оплата отправляется повторно, прежняя кнопка не подтверждает новую заявку',async t=>{
 const {env,call,sqlite}=await fixture(t);
 const id=(await call('create',{name:'Повторная оплата',category:'Гость'})).body.id;
 await call('payment-request',{id,amountRub:7000});
 const first=sqlite.prepare("SELECT id FROM admission_requests WHERE kind='payment'").get();
 await handleAdmissionCallback(callback(1,'adm:n:'+first.id),env);
 assert.equal((await call('tickets')).body.tickets.find(t=>t.id===id).paymentState,'rejected');
 await call('payment-request',{id,amountRub:7000});
 const second=sqlite.prepare("SELECT id FROM admission_requests WHERE kind='payment' AND state='pending'").get();
 assert.notEqual(first.id,second.id);
 await handleAdmissionCallback(callback(1,'adm:y:'+first.id),env);assert.equal((await call('share',{id})).status,403);
 await handleAdmissionCallback(callback(1,'adm:y:'+second.id),env);assert.equal((await call('share',{id})).status,200);
});
test('сбой Telegram не теряет заявку; повтор доставляет одно уведомление; поддельный callback не активирует билет',async t=>{
 const {env,call,sqlite,messages}=await fixture(t), normalFetch=globalThis.fetch;let failure=true;
 t.mock.method(globalThis,'fetch',async(url,opts)=>failure ? Response.json({ok:false}, {status:500}) : normalFetch(url,opts));
 const id=(await call('create',{name:'Оплата после сбоя',category:'Гость'})).body.id;
 assert.equal((await call('payment-request',{id,amountRub:7000})).status,503);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admission_requests WHERE kind='payment'").get().n,1);
 failure=false;assert.equal((await call('payment-request',{id,amountRub:7000})).status,200);
 assert.equal((await call('payment-request',{id,amountRub:7000})).status,200);
 assert.equal(messages.filter(m=>m.method==='sendMessage'&&m.body.chat_id===1).length,1);
 const request=sqlite.prepare("SELECT id FROM admission_requests WHERE kind='payment'").get();failure=true;
 await assert.rejects(handleAdmissionCallback(callback(1,'adm:y:'+request.id),env));
 assert.equal((await call('share',{id})).status,403);
 assert.equal(sqlite.prepare('SELECT state FROM admission_requests WHERE id=?').get(request.id).state,'pending');
});
test('два менеджера видят один счётчик, одновременный вход списывается один раз',async t=>{
 const {call,sqlite,tokens}=await fixture(t);sqlite.prepare("INSERT INTO admission_staff VALUES ('premiya-2026-demo',3,'Второй','second','approved','2026-11-19',NULL,NULL)").run();
 const results=await Promise.all([call('check-in',{token:tokens.active}),call('check-in',{token:tokens.active},{id:3})]);
 assert.deepEqual(results.map(r=>r.body.decision).sort(),['green','red']);
 assert.equal((await call('tickets')).body.stats.admitted,1);assert.equal((await call('tickets',undefined,{id:3})).body.stats.admitted,1);
});
test('одновременные решения владельца применяют ровно один результат; отменённый билет не активируется старой кнопкой',async t=>{
 const {env,call,sqlite}=await fixture(t);
 const id=(await call('create',{name:'Одновременное решение',category:'Гость'})).body.id;await call('payment-request',{id,amountRub:7000});
 const request=sqlite.prepare("SELECT id FROM admission_requests WHERE kind='payment'").get();
 const results=await Promise.all([decideAdmissionRequest(env,request.id,true,1),decideAdmissionRequest(env,request.id,false,1)]);
 assert.equal(results.filter(r=>r.already).length,1);assert.equal(results[0].state,results[1].state);
 const another=(await call('create',{name:'Отменённая оплата',category:'Гость'})).body.id;await call('payment-request',{id:another,amountRub:7000});
 const pending=sqlite.prepare("SELECT id FROM admission_requests WHERE ticket_id=?").get(another);
 await call('status',{id:another,status:'cancelled'},'admin');
 const r=await decideAdmissionRequest(env,pending.id,true,1);assert.equal(r.ok,false);
 assert.equal((await call('share',{id:another})).status,403);
});
test('интерфейс менеджера: добавление, сообщение об оплате, получение приглашения и общий счётчик без таблицы',async t=>{
 const {env,call,sqlite}=await fixture(t),ui=await browserFixture(env,{id:2,first_name:'Анна'},{url:'https://codrosta.club/admission'});
 assert.equal(ui.nodes.get('guest-panel').hidden,false);assert.equal(ui.nodes.get('show-create').hidden,false);
 assert.equal(ui.nodes.has('sync-payments'),false);assert.equal(ui.nodes.get('requests-panel').hidden,true);
 const form=ui.nodes.get('create-form');form.testEntries=[['name','Гость из интерфейса'],['company','Тестовая компания'],['category','Гость + игра']];
 await form.onsubmit({preventDefault(){}});
 const id=sqlite.prepare("SELECT id FROM admission_tickets WHERE person_name='Гость из интерфейса'").get().id;
 function texts(n){return [n.textContent,...n.children.flatMap(texts)];}
 function buttons(){const row=ui.nodes.get('guest-list').children.find(r=>texts(r).includes('Гость из интерфейса'));return row.children[2].children;}
 assert.equal(buttons().some(b=>b.textContent==='Отправить билет'),false);
 await buttons().find(b=>b.textContent==='Сообщить об оплате').onclick();
 assert.equal(ui.nodes.get('payment-amount').value,10000);ui.nodes.get('payment-comment').value='Перевод по СБП';
 await ui.nodes.get('payment-form').onsubmit({preventDefault(){}});
 assert.equal((await call('share',{id})).status,403);
 const request=sqlite.prepare("SELECT id FROM admission_requests WHERE ticket_id=?").get(id);
 await handleAdmissionCallback(callback(1,'adm:y:'+request.id),env);
 ui.nodes.get('refresh-guests').onclick();await ui.settle();
 await buttons().find(b=>b.textContent==='Отправить билет').onclick();
 assert.equal(ui.nodes.get('share-panel').hidden,false);
 assert.match(ui.nodes.get('share-message').value,/https:\/\/codrosta.club\/admission\?view=ticket#t=[a-f0-9]{64}/);
 assert.match(ui.nodes.get('share-telegram').href,/^https:\/\/t.me\/share\/url/);
 assert.equal(ui.intervals[0].ms,5000);
 await call('check-in',{id});ui.intervals[0].fn();await ui.settle();
 assert.equal(ui.nodes.get('stat-admitted').textContent,1);
});
