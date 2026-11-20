import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase} from './postgres.mjs';
const base=process.env.PREVIEW_TEST_ORIGIN || 'http://127.0.0.1:8080';
const db=createDatabase(process.env.DATABASE_URL);
let checked=0;
async function call(path,body,cookie,extra={}) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{
    ...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...extra},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,body:data,headers:response.headers};
}
function pass(name){console.log('PASS '+name);checked++;}
try {
  const ready=await call('/health/ready');assert.equal(ready.status,200);assert.equal(ready.body.database,'postgresql');pass('Russian preview and PostgreSQL ready');
  const events=await call('/api/events');assert.equal(events.status,200);assert(events.body.length>0);assert(events.body.every(e=>e.id.startsWith('preview-')));
  const content=await call('/api/content');assert(Object.keys(content.body).length>=40);
  assert((await call('/calendar.ics')).body.includes('BEGIN:VEVENT'));pass('Public events, content and calendar');
  const page=await call('/premiya');assert.equal(page.status,200);assert(page.body.includes('Дресс-код — коктейльный'));assert(!page.body.includes('Срок действия этих цен истёк'));assert(page.body.includes('Тестовая версия в Яндексе'));pass('Current prize page and preview banner');
  for(const path of ['/src/index.js','/.env','/package.json','/runtime-yandex/server.mjs','/migrations/0001_engagement.sql'])assert.equal((await call(path)).status,404);
  assert.equal((await call('/api/telegram-webhook',{})).status,404);
  assert.equal((await call('/api/admission/tickets')).status,401);
  assert.equal((await call('/api/submit',{},null,{origin:'https://evil.example'})).status,403);
  assert.equal((await call('/api/submit',{name:'Real Person',phone:'79999999999',telegram:'real'})).status,422);pass('Private source, webhook, authentication and real-data isolation');
  const signup=await call('/api/submit',{name:'ТЕСТ — Гость',phone:'+70000000000',telegram:'@demo_user',type:'event',eventId:events.body[0].id,event:events.body[0].title,package:'Гость'});
  assert.equal(signup.status,200,JSON.stringify(signup.body));assert.equal(signup.body.ok,true);
  assert((await db.prepare('SELECT id FROM event_signups WHERE event_id=? AND phone=?').bind(events.body[0].id,'70000000000').all()).results.length>0);pass('Event registration persists only in isolated PostgreSQL');
  const login=await call('/api/admission-demo/session',{role:'admin'});assert.equal(login.status,200);const admin=login.headers.get('set-cookie').split(';')[0];
  const hostLogin=await call('/api/admission-demo/session',{role:'host'});const host=hostLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/admission/me',undefined,admin)).body.canApprove,true);
  assert.equal((await call('/api/admission/me',undefined,host)).body.role,'host');
  assert.equal((await call('/api/admission/staff',undefined,host)).status,403);pass('Organizer and hostess permissions');
  const created=await call('/api/admission/create',{name:'ТЕСТ — Интеграция '+randomUUID().slice(0,8),company:'Тестовая компания',category:'Гость'},admin);
  assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.id;
  const pending=await call('/api/admission/check-in',{id},host);assert.equal(pending.body.decision,'red');
  assert.equal((await call('/api/admission/status',{id,status:'active'},admin)).status,200);
  const results=await Promise.all([call('/api/admission/check-in',{id},host),call('/api/admission/check-in',{id},host)]);
  assert.deepEqual(results.map(x=>x.body.decision).sort(),['green','red']);pass('Atomic first entry: one green and one red under concurrency');
  const ticket=await call('/api/admission/ticket',{token:'1'.repeat(64)});assert.equal(ticket.status,200);assert.equal(ticket.body.ticket.token,undefined);
  const ticketAgain=await call('/api/admission/ticket',{token:'1'.repeat(64)});assert.equal(ticketAgain.body.ticket.checkedInAt,ticket.body.ticket.checkedInAt);pass('Invitation read does not admit guest or expose token');
  const next=await call('/api/admission/create',{name:'ТЕСТ — Оплата '+randomUUID().slice(0,8),company:'Тестовая компания',category:'Гость'},host);
  assert.equal(next.status,201,JSON.stringify(next.body));
  assert.equal((await call('/api/admission/payment-request',{id:next.body.id,amountRub:7000,comment:'Тестовая оплата'},host)).status,200);
  const requests=await call('/api/admission/requests',undefined,admin);assert.equal(requests.status,200,JSON.stringify(requests.body));
  assert.equal((await call('/api/admission/tickets',undefined,host)).status,200);pass('Manager payment request, owner queue and ticket list');
  await db.pool.query('CREATE TABLE IF NOT EXISTS preview_atomic_test (id text PRIMARY KEY)');const key=randomUUID();
  await assert.rejects(db.batch([db.prepare('INSERT INTO preview_atomic_test(id) VALUES(?)').bind(key),db.prepare('INSERT INTO preview_atomic_test(id) VALUES(?)').bind(key)]));
  assert.equal(await db.prepare('SELECT id FROM preview_atomic_test WHERE id=?').bind(key).first(),null);pass('PostgreSQL batch rollback');
  console.log(JSON.stringify({passed:checked}));
}finally{await db.pool.end();}
