import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildSubscriptionReports, parseSubscriptionRows, parseSubscriptionDate, moscowDate, isMonthEnd, isRefusal } from '../src/subscription-rules.js';
import { runSubscriptionNotifications } from '../src/subscription-notifications.js';
import worker from '../src/index.js';

const header = ['', 'Дата начала', 'Дата окончания', 'Дата продления', 'Дата окончания', 'Статус', '', 'ФИО', '', '', '', '', 'Мобильный телефон', '', '', '', 'Телеграм username'];
function row(name, end, status = '', renewalEnd = '', renewalStart = '') {
  const r = Array(17).fill('');
  r[1] = '01.01.2025'; r[2] = end; r[3] = renewalStart; r[4] = renewalEnd;
  r[5] = status; r[7] = name; r[16] = '@test'; return r;
}
test('четыре этапа объединены; отказ с датой исключён; остальные статусы продолжают цепочку', () => {
  const rows = [header, row('Неделя', '30.09.2026', 'уведомила'), row('День', '24.09.2026', 'уведомил 2'),
    row('СМС', '22.09.2026', 'нет ответа'), row('Звонок', '20.09.2026', 'вотсап'), row('Исключён', '30.09.2026', ' ОТКАЗ 23.09 (причина) '), row('Сегодня', '23.09.2026')];
  const report = buildSubscriptionReports(rows, '2026-09-23');
  assert.equal(report.final, null);
  for (const title of ['НЕДЕЛЯ', 'ДЕНЬ', 'СМС', 'ЗВОНОК']) assert.ok(report.daily.includes(`<b>${title}`));
  assert.ok(!report.daily.includes('Исключён')); assert.ok(!report.daily.includes('Сегодня'));
  assert.equal((report.daily.match(/1\. /g) || []).length, 4);
});
test('новый период E отменяет старые напоминания C; строка без телефона/username не теряется', () => {
  const renewed = row('Продлён', '22.09.2026', '', '22.09.2027', '23.09.2026');
  const noContacts = row('Без контактов', '30.09.2026'); noContacts[16] = '';
  const r = buildSubscriptionReports([header, renewed, noContacts], '2026-09-23');
  assert.ok(!r.daily.includes('Продлён')); assert.ok(r.daily.includes('Без контактов / — / 30.09.2026'));
});
test('ФИНАЛ: только отказ с актуальным окончанием текущего месяца, отдельно от ежедневного', () => {
  const rows = [header, row('Отказ месяца', '01.09.2026', 'отказ 23.09'), row('Последний день', '30.09.2026', 'отказ'),
    row('Старый отказ', '31.08.2026', 'отказ'), row('Будущий', '01.10.2026', 'отказ'),
    row('Продлён', '10.09.2026', 'отказ', '10.09.2027', '11.09.2026'), row('Нет ответа', '10.09.2026', 'уведомила'),
    row('Неделя', '07.10.2026')];
  const r = buildSubscriptionReports(rows, '2026-09-30');
  assert.ok(r.final.startsWith('<b>ФИНАЛ</b>')); assert.ok(r.final.includes('Отказ месяца')); assert.ok(r.final.includes('Последний день'));
  for (const name of ['Старый отказ','Будущий','Продлён','Нет ответа','Неделя']) assert.ok(!r.final.includes(name));
  assert.ok(r.daily.includes('Неделя')); assert.ok(!r.daily.includes('Отказ месяца'));
  assert.equal(buildSubscriptionReports(rows, '2026-09-29').final, null);
});
test('московский день, границы месяца/года и високосный февраль', () => {
  assert.equal(moscowDate(new Date('2026-09-22T21:00:00Z')), '2026-09-23');
  for (const date of ['2026-01-31','2026-02-28','2028-02-29','2026-04-30','2026-12-31']) assert.ok(isMonthEnd(date));
  assert.equal(isMonthEnd('2028-02-28'), false);
  assert.ok(buildSubscriptionReports([header,row('Неделя','07.01.2027'),row('Звонок','28.12.2026')], '2026-12-31').daily.includes('ЗВОНОК'));
});
test('даты Sheets, проверка ошибок, HTML, пустой отчёт и граница ПОТЕНЦИАЛЬНЫЕ', () => {
  assert.equal(parseSubscriptionDate(46295), '2026-09-30');
  assert.equal(parseSubscriptionDate('31.02.2026'), null);
  assert.equal(parseSubscriptionDate('29.02.2028'), '2028-02-29');
  assert.equal(parseSubscriptionDate('2026-09-30'), '2026-09-30');
  const stop = row('ПОТЕНЦИАЛЬНЫЕ',''); stop[5] = 'ПОТЕНЦИАЛЬНЫЕ';
  const rows = [header,row('<Имя & Co>','30.09.2026'), stop, row('Не резидент','30.09.2026')];
  const r = buildSubscriptionReports(rows,'2026-09-23');
  assert.ok(r.daily.includes('&lt;Имя &amp; Co&gt;')); assert.ok(!r.daily.includes('Не резидент'));
  assert.equal(buildSubscriptionReports([header], '2026-09-23').daily,null);
  assert.ok(buildSubscriptionReports([header], '2026-09-30').final.includes('Таких резидентов нет'));
  const invalid = parseSubscriptionRows([header,row('Ошибка','30.09.2026','','ошибка','23.09.2026')]);
  assert.equal(invalid.residents.length,0); assert.equal(invalid.issues.length,1);
  assert.throws(()=>parseSubscriptionRows([['wrong']]),/структура/);
  assert.equal(isRefusal('не отказ'),false); assert.equal(isRefusal('ОТКАЗ'),true);
});

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE residents (telegram_username TEXT, chat_id INTEGER); INSERT INTO residents VALUES (\'Kodrosta\',123);');
  sqlite.exec(readFileSync(new URL('../migrations/0006_cron_log.sql',import.meta.url),'utf8'));
  return { sqlite, prepare(sql) { const stmt = sqlite.prepare(sql); let values = []; return {
    bind(...args) { values=args; return this; },
    async all() { return {results:stmt.all(...values)}; },
    async run() { const r=stmt.run(...values);return {meta:{changes:Number(r.changes)}}; },
  }; } };
}
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const der=await crypto.subtle.exportKey('pkcs8',pair.privateKey);
const testCreds=JSON.stringify({client_email:'test@example.invalid',private_key:`-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`});
function env() { return {DB:d1(),BOT_TOKEN:'test-not-a-token',SUBSCRIPTION_ALERT_USERNAME:'Kodrosta',GOOGLE_SERVICE_ACCOUNT_JSON:testCreds,GOOGLE_SHEET_ID:'test'}; }
function network(t, rows, telegramFailure=false) {
  const sent=[]; let sheetsReads=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'test'});
    if(url.startsWith('https://sheets.googleapis.com/')) {sheetsReads++; return Response.json({values:rows});}
    if(url.startsWith('https://api.telegram.org/bottest-not-a-token/')) {
      const data=typeof options.body==='string'?JSON.parse(options.body):options.body;
      sent.push({url,data});
      return telegramFailure?Response.json({ok:false,error_code:403},{status:403}):Response.json({ok:true,result:{message_id:sent.length}});
    }
    throw Error('Unexpected network '+url);
  });
  return {sent,get sheetsReads(){return sheetsReads;}};
}
test('ежедневная доставка: один свежий снимок, один получатель, повтор не дублирует', async t=>{
  const e=env();const net=network(t,[header,row('Тест','30.09.2026')]);
  await runSubscriptionNotifications(e,new Date('2026-09-23T05:00Z'));
  await runSubscriptionNotifications(e,new Date('2026-09-23T05:01Z'));
  assert.equal(net.sent.length,1); assert.equal(net.sent[0].data.chat_id,123);assert.equal(net.sheetsReads,1);
  assert.equal(e.DB.sqlite.prepare('SELECT state FROM subscription_deliveries').get().state,'sent');
});
test('конец месяца: ежедневный + ФИНАЛ, повторный запуск не дублирует ни один',async t=>{
  const e=env();const net=network(t,[header,row('Неделя','07.10.2026'),row('Отказ','25.09.2026','отказ')]);
  await runSubscriptionNotifications(e,new Date('2026-09-30T05:00Z'));
  await runSubscriptionNotifications(e,new Date('2026-09-30T05:01Z'));
  assert.equal(net.sent.length,2);assert.equal(net.sheetsReads,1);
});
test('ошибка Telegram не становится успешной доставкой; повтор может доставить',async t=>{
  const e=env();const net=network(t,[header,row('Тест','30.09.2026')],true);
  await assert.rejects(runSubscriptionNotifications(e,new Date('2026-09-23T05:00Z')),/Telegram/);
  assert.equal(e.DB.sqlite.prepare('SELECT state FROM subscription_deliveries').get().state,'failed');
  t.mock.restoreAll(); network(t,[header,row('Тест','30.09.2026')]);
  await runSubscriptionNotifications(e,new Date('2026-09-23T05:01Z'));
  assert.equal(e.DB.sqlite.prepare('SELECT state FROM subscription_deliveries').get().state,'sent');
  assert.equal(net.sent.length,1);
});
test('слишком большой отчёт отправляется одним документом, без потери строк',async t=>{
  const e=env(); const net=network(t,[header,...Array.from({length:180},(_,i)=>row('Тест '+i,'30.09.2026'))]);
  await runSubscriptionNotifications(e,new Date('2026-09-23T05:00Z'));
  assert.equal(net.sent.length,1); assert.ok(net.sent[0].url.endsWith('/sendDocument'));
  assert.ok((await net.sent[0].data.get('document').text()).includes('Тест 179'));
});
test('scheduled запускает новый регламент и пишет результат после доставки',async t=>{
  const e=env(); network(t,[header,row('Тест','30.09.2026')]); const jobs=[];
  await worker.scheduled({cron:'0 5 * * *',scheduledTime:Date.parse('2026-09-23T05:00Z')},e,{waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);
  assert.equal(e.DB.sqlite.prepare('SELECT note FROM cron_runs').get().note,'daily: доставлено');
});
test('ошибка чтения таблицы и отсутствие получателя не приводят к ложному успешному отчёту',async t=>{
  const e=env(); const net=network(t,[['wrong']]);
  await assert.rejects(runSubscriptionNotifications(e,new Date('2026-09-23T05:00Z')),/структура/);
  assert.equal(net.sent.length,0);
  e.DB.sqlite.exec('DELETE FROM residents');
  await assert.rejects(runSubscriptionNotifications(e,new Date('2026-09-23T05:00Z')),/получателя/);
  assert.equal(net.sent.length,0);
});
