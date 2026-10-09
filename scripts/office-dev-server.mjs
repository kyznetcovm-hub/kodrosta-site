// Локальный стенд «Офиса в кармане» для проверки до публикации:
// настоящий код Worker'а (src/index.js) + база sqlite в памяти + вход,
// подписанный тестовым токеном (как это делает Telegram), от имени @Kodrosta.
// В Telegram и в рабочую базу ничего не уходит.
//
// Запуск: node scripts/office-dev-server.mjs  →  http://127.0.0.1:8091/office
// (в .claude/launch.json — конфигурация «office-dev»).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { default: worker } = await import(ROOT + '/src/index.js');
const TOKEN = 'local-dev-token';
const PORT = 8091;

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE residents (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT, phone TEXT,
  telegram_username TEXT, chat_id INTEGER UNIQUE, active INTEGER DEFAULT 1);
  INSERT INTO residents (full_name, telegram_username, chat_id) VALUES ('Код Роста', 'kodrosta', 222);
  CREATE TABLE touches (id INTEGER PRIMARY KEY AUTOINCREMENT, resident_id INTEGER, kind TEXT, note TEXT,
    person_name TEXT, person_username TEXT, created_at TEXT);`);
sqlite.exec(readFileSync(ROOT + '/migrations/0002_events.sql', 'utf8'));
sqlite.exec(readFileSync(ROOT + '/migrations/0006_event_signups.sql', 'utf8'));

// несколько мероприятий текущего месяца (по Москве) — для списков и привязки денег
const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const addEvent = sqlite.prepare("INSERT INTO events (id, title, tag, start, end, place, description, created_at) VALUES (?, ?, ?, ?, ?, 'Место', 'Описание', 'dev')");
addEvent.run('biznes-banya', 'Бизнес-баня', 'Бизнес-баня', month + '-08T18:00:00', month + '-08T23:00:00');
addEvent.run('rubezh', 'РУБЕЖ', 'Событие клуба', month + '-24T11:00:00', month + '-24T20:00:00');
addEvent.run('kalorimetr', 'Калориметр', 'Марафон', month + '-27T10:00:00', month + '-27T12:00:00');

const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    let v = [];
    return {
      bind(...a) { v = a; return this; },
      async first() { return st.get(...v) ?? null; },
      async all() { return { results: st.all(...v) }; },
      async run() { return { meta: { changes: Number(st.run(...v).changes) } }; },
    };
  },
  async batch(stmts) {
    sqlite.exec('BEGIN');
    try { for (const s of stmts) await s.run(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
const env = { DB, BOT_TOKEN: TOKEN, ADMIN_USERNAMES: 'mytolstoy,Kodrosta', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };

// initData так, как её подписывает Telegram (core.telegram.org/bots/webapps)
function initData() {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 222, first_name: 'Код Роста', username: 'Kodrosta' }) });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'POST'
      ? await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); })
      : undefined;
    const r = await worker.fetch(new Request('https://codrosta.club' + req.url, { method: req.method, headers: req.headers, body }), env, {});
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'text/plain' });
    res.end(await r.text());
    return;
  }
  const path = url.pathname === '/' || url.pathname === '/office' ? '/office.html' : url.pathname;
  if (path.includes('..') || !existsSync(ROOT + path)) { res.writeHead(404); res.end(); return; }
  let out = readFileSync(ROOT + path);
  // вместо настоящего Telegram SDK — заглушка с подписанным входом
  if (path === '/office.html') {
    out = String(out).replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>',
      `<script>window.Telegram={WebApp:{initData:${JSON.stringify(initData())},ready(){},expand(){},BackButton:{show(){},hide(){},onClick(){}}}};</script>`);
  }
  res.writeHead(200, { 'content-type': TYPES[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(out);
}).listen(PORT, '127.0.0.1', () => console.log(`Офис (стенд): http://127.0.0.1:${PORT}/office`));
