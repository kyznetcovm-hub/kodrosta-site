import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ensureAdmission,admissionEvent} from '../src/admission.js';

export async function initialize(env) {
  const db=env.DB;
  await db.pool.query('CREATE TABLE IF NOT EXISTS preview_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  for (const name of (await readdir(resolve(import.meta.dirname,'../migrations'))).filter(n=>n.endsWith('.sql')).sort()) {
    if ((await db.pool.query('SELECT name FROM preview_migrations WHERE name=$1',[name])).rowCount) continue;
    await db.exec(await readFile(resolve(import.meta.dirname,'../migrations',name),'utf8'));
    await db.pool.query('INSERT INTO preview_migrations(name) VALUES($1)',[name]);
  }
  await ensureAdmission(env);
  const now=new Date().toISOString();
  await db.prepare(`INSERT INTO residents (full_name,telegram_username,chat_id) VALUES ('Тестовый организатор','demo_admin',826001)
    ON CONFLICT(chat_id) DO NOTHING`).run();
  await db.prepare(`INSERT INTO admission_staff(event_id,telegram_id,person_name,username,state,requested_at)
    VALUES (?,826002,'Тестовая хостес','demo_host','approved',?) ON CONFLICT(event_id,telegram_id) DO NOTHING`).bind(admissionEvent(env).id,now).run();
  for (const [i,status] of ['active','active','pending','cancelled'].entries()) {
    await db.prepare(`INSERT INTO admission_tickets(id,event_id,token,person_name,company,category,status,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind('preview-'+i,admissionEvent(env).id,String(i+1).repeat(64),
      'ТЕСТ — Гость '+(i+1),'Тестовая компания','Гость',status,now).run();
  }
  // Копируются только уже опубликованные тексты и мероприятия, без участников/заявок.
  const content=JSON.parse(await readFile(resolve(import.meta.dirname,'seed/content.json'),'utf8'));
  for (const [key,value] of Object.entries(content)) await db.prepare(`INSERT INTO content_fields(key,value,updated_at)
    VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(key,String(value),now).run();
  const events=JSON.parse(await readFile(resolve(import.meta.dirname,'seed/events.json'),'utf8'));
  for (const e of events) await db.prepare(`INSERT INTO events(id,title,tag,start,"end",place,description,full_description,created_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start=excluded.start,"end"=excluded."end"`)
    .bind('preview-'+e.id,e.title,e.tag,e.start,e.end,e.place,e.description,JSON.stringify(e.fullDescription || []),e.createdAt || now).run();
  return {eventId:admissionEvent(env).id};
}
