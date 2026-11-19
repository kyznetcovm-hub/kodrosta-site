// Локальная демонстрация. Никаких обращений к боевой базе и отправок в Telegram.
// Запуск: node scripts/admission-demo-server.mjs
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { ensureAdmission, admissionEvent } from '../src/admission.js';
import { syncAdmissionFromSheet } from '../src/admission-sync.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(ROOT, '.wrangler'), { recursive: true });
const sqlite = new DatabaseSync(resolve(ROOT, '.wrangler/admission-demo.sqlite'));
sqlite.exec("CREATE TABLE IF NOT EXISTS residents (telegram_username TEXT, chat_id INTEGER); INSERT INTO residents SELECT 'demo_admin', 826001 WHERE NOT EXISTS (SELECT 1 FROM residents WHERE chat_id = 826001)");
const DB = { prepare(sql) { const st = sqlite.prepare(sql); let values = []; return {
  bind(...args) { values = args; return this; },
  async first() { return st.get(...values) ?? null; },
  async all() { return { results: st.all(...values) }; },
  async run() { return { meta: { changes: Number(st.run(...values).changes) } }; },
}; }, async batch(statements) {
  sqlite.exec('BEGIN');
  try { const results=[]; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
  catch (err) { sqlite.exec('ROLLBACK'); throw err; }
} };
const snapshotPath = resolve(ROOT,'.wrangler/admission-sheet-snapshot.json');
const snapshotExists = existsSync(snapshotPath);
const env = { DB, BOT_TOKEN: randomBytes(32).toString('hex'), ADMIN_USERNAMES: 'demo_admin',
  ADMISSION_EVENT_ID: snapshotExists ? 'premiya-2026-sheet-demo' : 'premiya-2026-demo' };
if (snapshotExists) {
  const initial = JSON.parse(await readFile(snapshotPath,'utf8'));
  env.ADMISSION_SOURCE_LABEL = 'Тестовый снимок таблицы от ' + new Date(initial.fetchedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}) + ' МСК (не живая синхронизация)';
  env.ADMISSION_READ_SHEET = async () => JSON.parse(await readFile(snapshotPath,'utf8')).values;
}
await ensureAdmission(env);
sqlite.prepare(`INSERT INTO admission_staff (event_id,telegram_id,person_name,username,state,requested_at)
  VALUES (?,826002,'Тестовая хостес','demo_host','approved',?) ON CONFLICT(event_id,telegram_id) DO UPDATE SET state='approved'`)
  .run(admissionEvent(env).id,new Date().toISOString());
if (snapshotExists) await syncAdmissionFromSheet(env,admissionEvent(env).id);
if (!snapshotExists && !sqlite.prepare('SELECT COUNT(*) AS n FROM admission_tickets WHERE event_id=?').get(admissionEvent(env).id).n) {
  const guests = [
    ['Анна Смирнова', 'Мастерская «Форма»', 'Номинант', 'active'],
    ['Илья Петров', 'Архитектура будущего', 'Резидент', 'active'],
    ['Мария Орлова', 'Студия «Линия»', 'VIP', 'active'],
    ['Олег Волков', 'Вектор развития', 'Гость', 'active'],
    ['Дина Ким', 'Команда «Среда»', 'Партнёр', 'active'],
    ['Павел Рощин', 'Механика роста', 'Номинант', 'active'],
    ['Елена Соколова', 'Бюро «Точка»', 'Резидент', 'active'],
    ['Роман Белов', 'Проект «Горизонт»', 'Гость', 'pending'],
    ['Дарья Морозова', 'Сервис «Рядом»', 'Гость', 'cancelled'],
    ['Артём Лебедев', 'Ателье «Смысл»', 'Партнёр', 'active'],
  ];
  for (let i = 0; i < guests.length; i++) sqlite.prepare(`INSERT INTO admission_tickets
    (id,event_id,token,person_name,company,category,status,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('demo-' + (i + 1), admissionEvent(env).id, randomBytes(32).toString('hex'), ...guests[i], new Date().toISOString());
}
function initData(role) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: role === 'host' ? 826002 : 826001, username: role === 'host' ? 'demo_host' : 'demo_admin' }) });
  const check = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => k + '=' + v).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex')); return p.toString();
}
const sessions = new Map();
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function reply(res, status, value, headers = {}) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(value)); }
const server = http.createServer(async (req, res) => {
  try {
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) return reply(res, 403, { error: 'Только локальная демонстрация' });
    const origin = 'http://' + req.headers.host, url = new URL(req.url, origin);
    if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: 'Чужой источник запроса' });
    let raw = '';
    if (req.method === 'POST') { for await (const part of req) { raw += part; if (raw.length > 4096) return reply(res, 413, { error: 'Слишком большой запрос' }); } }
    if (url.pathname === '/api/admission-demo/info') return reply(res, 200, { demo: true });
    if (url.pathname === '/api/admission-demo/session' && req.method === 'POST') {
      let data; try { data = JSON.parse(raw); } catch { return reply(res, 400, { error: 'Некорректный запрос' }); }
      if (!['admin', 'host'].includes(data.role)) return reply(res, 400, { error: 'Некорректная роль' });
      const key = randomBytes(24).toString('hex'); sessions.set(key, { role: data.role, expires: Date.now() + 12 * 3600000 });
      return reply(res, 200, { ok: true }, { 'set-cookie': 'admission_demo=' + key + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' });
    }
    if (url.pathname === '/api/admission-demo/logout' && req.method === 'POST') return reply(res, 200, { ok: true }, { 'set-cookie': 'admission_demo=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    if (url.pathname.startsWith('/api/admission/')) {
      const headers = new Headers(req.headers);
      // Тестовые роли существуют только в этом локальном сервере, не в Worker.
      const session = sessions.get((req.headers.cookie || '').match(/(?:^|;\s*)admission_demo=([a-f0-9]+)/)?.[1]);
      if (session && session.expires > Date.now()) {
        headers.set('authorization', 'tma ' + initData(session.role)); headers.delete('x-admission-key');
      }
      const response = await worker.fetch(new Request('https://codrosta.club' + req.url, {
        method: req.method, headers, ...(req.method === 'POST' ? { body: raw } : {}),
      }), env, {});
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    const name = url.pathname === '/' || url.pathname === '/admission' ? '/admission.html' : url.pathname;
    // Код сервера, SQLite и конфигурация через HTTP не раздаются.
    if (!(name === '/admission.html' || name === '/css/admission.css' || name === '/js/admission.js' || /^\/js\/vendor\/(?:qrcode-1\.4\.4\.min|jsqr-1\.4\.0)\.js$/.test(name) || /^\/assets\/premiya\/[\w-]+\.svg$/.test(name))) return reply(res, 404, { error: 'Страница не найдена' });
    const content = await readFile(resolve(ROOT, '.' + name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(content);
  } catch (_) { reply(res, 500, { error: 'Ошибка локальной демонстрации' }); }
});
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? 'Порт 8789 занят. Закрой предыдущую демонстрацию.'
    : err.code === 'EPERM' ? 'Среда запретила локальный сервер. Запусти эту команду в обычном терминале.'
    : 'Не удалось запустить демонстрацию: ' + err.code);
  sqlite.close(); process.exitCode = 1;
});
server.listen(8789, '127.0.0.1', () => console.log('Демонстрация билетов: http://127.0.0.1:8789/admission'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { sqlite.close(); process.exit(0); }));
