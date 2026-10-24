// Тесты «Рандомайзера» (src/randomizer.js): вход только для админов, участники без
// телефонов и без повторов, победители выбираются на сервере и пишутся в историю.
// Запуск: node --test scripts/test-randomizer.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { pickWinners } from '../src/randomizer.js';

const BOT_TOKEN = 'fixture-not-a-token';

function initDataFor(user) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const checkString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(checkString).digest('hex'));
  return params.toString();
}

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_engagement.sql', '0002_events.sql', '0006_event_signups.sql']) {
    sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  }
  sqlite.exec(`INSERT INTO residents (full_name, telegram_username, chat_id) VALUES ('Код Роста', 'kodrosta', 222), ('Чужой', 'someresident', 333);
    INSERT INTO events (id, title, tag, start, end, place, description, created_at)
      VALUES ('ev1', 'Связи решают', 'Встреча', '2099-01-01T18:00:00', '2099-01-01T20:00:00', 'Офис', 'Д', 'x'),
             ('ev2', 'Пустое', 'Встреча', '2099-02-01T18:00:00', '2099-02-01T20:00:00', 'Офис', 'Д', 'x');
    INSERT INTO event_signups (event_id, tg_user_id, username, person_name, phone, source, created_at) VALUES
      ('ev1', 1, 'anna', 'Анна Смирнова', '+79001112233', 'bot', 'x'),
      ('ev1', 11, 'anna', 'Анна Смирнова', '+79001112233', 'site', 'x'),
      ('ev1', 2, 'ilya', 'Илья Петров', '+79004445566', 'site', 'x'),
      ('ev1', 3, 'oleg', 'Олег Волков', NULL, 'manual', 'x');`);
  t.after(() => sqlite.close());
  const DB = { prepare(sql) { const st = sqlite.prepare(sql); let v = []; return {
    bind(...a) { v = a; return this; },
    async first() { return st.get(...v) ?? null; },
    async all() { return { results: st.all(...v) }; },
    async run() { const r = st.run(...v); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  }; } };
  return { sqlite, env: { DB, BOT_TOKEN, ADMIN_USERNAMES: 'mytolstoy,Kodrosta' } };
}

const admin = initDataFor({ id: 222, first_name: 'Код Роста', username: 'Kodrosta' });

function call(env, path, { initData = admin, body } = {}) {
  const headers = initData === null ? {} : { authorization: 'tma ' + initData };
  return worker.fetch(new Request('https://codrosta.club' + path, {
    method: body ? 'POST' : 'GET', headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }), env, {});
}

test('без входа и не админам рандомайзер закрыт', async (t) => {
  const { env } = fixture(t);
  assert.equal((await call(env, '/api/randomizer/events', { initData: null })).status, 401);
  const stranger = initDataFor({ id: 333, first_name: 'Чужой', username: 'someresident' });
  assert.equal((await call(env, '/api/randomizer/participants?eventId=ev1', { initData: stranger })).status, 403);
  assert.equal((await call(env, '/api/randomizer/draw', { initData: stranger, body: { eventId: 'ev1', winners: 1 } })).status, 403);
});

test('участники: имя и @username, без телефонов и повторов', async (t) => {
  const { env } = fixture(t);
  const resp = await call(env, '/api/randomizer/participants?eventId=ev1');
  const text = await resp.text();
  assert.ok(!/phone|7900|\+7/.test(text), 'телефон попал в ответ');
  const body = JSON.parse(text);
  assert.deepEqual(body.participants.map((p) => p.username), ['anna', 'ilya', 'oleg']);
  assert.equal(body.participants[0].name, 'Анна Смирнова');
});

test('список событий: число участников из тех же данных', async (t) => {
  const { env } = fixture(t);
  const body = await (await call(env, '/api/randomizer/events')).json();
  assert.deepEqual(body.events.map((e) => [e.id, e.count, e.upcoming]), [['ev1', 3, true], ['ev2', 0, true]]);
});

test('розыгрыш: победители из участников, запись в историю без списка участников', async (t) => {
  const { env, sqlite } = fixture(t);
  const resp = await call(env, '/api/randomizer/draw', { body: { eventId: 'ev1', winners: 2 } });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.winners.length, 2);
  assert.equal(new Set(body.winners.map((w) => w.username)).size, 2);
  assert.ok(body.winners.every((w) => ['anna', 'ilya', 'oleg'].includes(w.username)));
  assert.equal(body.total, 3);
  const hist = await (await call(env, '/api/randomizer/history')).json();
  assert.equal(hist.raffles.length, 1);
  assert.deepEqual(hist.raffles[0].winners, body.winners);
  assert.equal(hist.raffles[0].eventTitle, 'Связи решают');
  assert.equal(hist.raffles[0].drawnBy, 'kodrosta');
  const row = sqlite.prepare('SELECT winners_json FROM raffles').get();
  assert.ok(!row.winners_json.includes('7900'));
});

test('розыгрыш: неверное число победителей, мало участников, нет события', async (t) => {
  const { env } = fixture(t);
  assert.equal((await call(env, '/api/randomizer/draw', { body: { eventId: 'ev1', winners: 4 } })).status, 400);
  assert.equal((await call(env, '/api/randomizer/draw', { body: { eventId: 'ev1', winners: 0 } })).status, 400);
  const few = await call(env, '/api/randomizer/draw', { body: { eventId: 'ev2', winners: 1 } });
  assert.equal(few.status, 400);
  assert.equal((await few.json()).error, 'not_enough');
  assert.equal((await call(env, '/api/randomizer/draw', { body: { eventId: 'nope', winners: 1 } })).status, 404);
  const hist = await (await call(env, '/api/randomizer/history')).json();
  assert.equal(hist.raffles.length, 0); // неудавшиеся розыгрыши в историю не попадают
});

test('pickWinners: без повторов и каждый может выиграть', () => {
  const people = [1, 2, 3, 4].map((n) => ({ name: 'n' + n, username: 'u' + n }));
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const w = pickWinners(people, 3);
    assert.equal(new Set(w.map((x) => x.username)).size, 3);
    w.forEach((x) => seen.add(x.username));
  }
  assert.equal(seen.size, 4);
});
