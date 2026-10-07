// Тесты Mini App «Офис в кармане» (src/office.js): проверка входа через
// Telegram initData и доступ только админам бота.
// Запуск: node --test scripts/test-office.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { verifyInitData } from '../src/office.js';

const BOT_TOKEN = 'fixture-not-a-token';
const now = () => Math.floor(Date.now() / 1000);

// initData так, как её подписывает Telegram (core.telegram.org/bots/webapps)
function signInitData(fields, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  const checkString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(checkString).digest('hex'));
  return params.toString();
}

function initDataFor(user, authDate = now()) {
  return signInitData({ auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify(user) });
}

function fixtureEnv(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE residents (telegram_username TEXT, chat_id INTEGER);
    INSERT INTO residents VALUES ('mytolstoy', 111), ('kodrosta', 222), ('someresident', 333);`);
  t.after(() => sqlite.close());
  const DB = { prepare(sql) { const statement = sqlite.prepare(sql); let values = []; return {
    bind(...args) { values = args; return this; },
    async first() { return statement.get(...values) ?? null; },
    async all() { return { results: statement.all(...values) }; },
  }; } };
  return { DB, BOT_TOKEN, ADMIN_USERNAMES: 'mytolstoy,Kodrosta' };
}

function me(env, initData) {
  const headers = initData === undefined ? {} : { authorization: 'tma ' + initData };
  return worker.fetch(new Request('https://codrosta.club/api/office/me', { headers }), env, {});
}

test('подпись: верная принимается, подменённая и чужим токеном — нет', async () => {
  const data = initDataFor({ id: 111, first_name: 'Михаил', username: 'mytolstoy' });
  assert.equal((await verifyInitData(data, BOT_TOKEN)).id, 111);
  assert.equal(await verifyInitData(data.replace('111', '222'), BOT_TOKEN), null);
  assert.equal(await verifyInitData(data, 'other-token'), null);
  assert.equal(await verifyInitData('user=%7B%22id%22%3A111%7D', BOT_TOKEN), null);
});

test('подпись: просроченная (старше суток) не принимается', async () => {
  const old = initDataFor({ id: 111, username: 'mytolstoy' }, now() - 25 * 60 * 60);
  assert.equal(await verifyInitData(old, BOT_TOKEN), null);
});

test('Михаил входит и видит своё имя', async (t) => {
  const resp = await me(fixtureEnv(t), initDataFor({ id: 111, first_name: 'Михаил', username: 'mytolstoy' }));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.deepEqual(body.user, { id: 111, username: 'mytolstoy', firstName: 'Михаил' });
  assert.equal(resp.headers.get('cache-control'), 'no-store');
});

test('@Kodrosta входит, но без имени профиля в приветствии', async (t) => {
  const resp = await me(fixtureEnv(t), initDataFor({ id: 222, first_name: 'Код Роста', username: 'Kodrosta' }));
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).user.firstName, null);
});

test('резидент (не админ) — 403', async (t) => {
  const resp = await me(fixtureEnv(t), initDataFor({ id: 333, username: 'someresident' }));
  assert.equal(resp.status, 403);
});

test('чужой аккаунт с ником админа, но другим ID — 403', async (t) => {
  const resp = await me(fixtureEnv(t), initDataFor({ id: 999, username: 'mytolstoy' }));
  assert.equal(resp.status, 403);
});

test('без подписи и с мусором — 401, данных нет', async (t) => {
  const env = fixtureEnv(t);
  assert.equal((await me(env)).status, 401);
  assert.equal((await me(env, 'garbage')).status, 401);
  const resp = await worker.fetch(new Request('https://codrosta.club/api/office/me?user=111'), env, {});
  assert.equal(resp.status, 401);
});

test('кнопка «Офис» у поля ввода: ставится админу сама и один раз, резиденту — нет', async (t) => {
  const { handleTelegramUpdate } = await import('../src/engagement.js');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE residents (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT, phone TEXT,
    telegram_username TEXT, chat_id INTEGER UNIQUE, active INTEGER DEFAULT 1);
    CREATE TABLE pending_edits (telegram_user_id INTEGER PRIMARY KEY, section TEXT, created_at TEXT);`);
  t.after(() => sqlite.close());
  const DB = { prepare(sql) { const st = sqlite.prepare(sql); let v = []; return {
    bind(...a) { v = a; return this; },
    async first() { return st.get(...v) ?? null; },
    async all() { return { results: st.all(...v) }; },
    async run() { return { meta: { changes: Number(st.run(...v).changes) } }; },
  }; } };
  const calls = [];
  let menuButton = { type: 'commands' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(options.body || '{}');
    calls.push({ method, body });
    if (method === 'getChatMenuButton') return Response.json({ ok: true, result: menuButton });
    if (method === 'setChatMenuButton') { menuButton = body.menu_button; return Response.json({ ok: true, result: true }); }
    return Response.json({ ok: true, result: {} });
  });
  const env = { DB, BOT_TOKEN, ADMIN_USERNAMES: 'mytolstoy,Kodrosta' };
  const msg = (id, username, text) => ({ message: { from: { id, username, first_name: 'X' }, chat: { id, type: 'private' }, text } });

  await handleTelegramUpdate(msg(5001, 'mytolstoy', 'привет'), env);
  await handleTelegramUpdate(msg(5001, 'mytolstoy', 'ещё'), env);
  const sets = calls.filter((c) => c.method === 'setChatMenuButton');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].body.chat_id, 5001);
  assert.equal(sets[0].body.menu_button.web_app.url, 'https://codrosta.club/office');

  calls.length = 0;
  await handleTelegramUpdate(msg(7001, 'someresident', 'привет'), env);
  assert.equal(calls.filter((c) => c.method.endsWith('ChatMenuButton')).length, 0);
});
