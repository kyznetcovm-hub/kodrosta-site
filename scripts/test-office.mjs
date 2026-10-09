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

// ---- Этап 3: события, регистрации, план участников --------------------------
import { readFileSync } from 'node:fs';
import { parseEventMessage, renderEventTemplate, insertEvent, updateEvent, getEventById } from '../src/events-store.js';

function eventsEnv(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE residents (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT, phone TEXT,
    telegram_username TEXT, chat_id INTEGER UNIQUE, active INTEGER DEFAULT 1);
    INSERT INTO residents (full_name, telegram_username, chat_id) VALUES ('Михаил', 'mytolstoy', 111), ('Код Роста', 'kodrosta', 222), ('Иван', 'ivan', NULL);
    CREATE TABLE touches (id INTEGER PRIMARY KEY AUTOINCREMENT, resident_id INTEGER, kind TEXT, note TEXT,
      person_name TEXT, person_username TEXT, created_at TEXT);`);
  // схема events — до плана участников, как в рабочей базе сейчас
  sqlite.exec(readFileSync(new URL('../migrations/0002_events.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0006_event_signups.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = { prepare(sql) { const st = sqlite.prepare(sql); let v = []; return {
    bind(...a) { v = a; return this; },
    async first() { return st.get(...v) ?? null; },
    async all() { return { results: st.all(...v) }; },
    async run() { return { meta: { changes: Number(st.run(...v).changes) } }; },
  }; } };
  return { sqlite, env: { DB, BOT_TOKEN, ADMIN_USERNAMES: 'mytolstoy,Kodrosta' } };
}

function addEvent(sqlite, id, title, start, tag = 'Обучение') {
  sqlite.prepare(`INSERT INTO events (id, title, tag, start, end, place, description, created_at)
    VALUES (?, ?, ?, ?, ?, 'Место', 'Описание', '2026-01-01')`).run(id, title, tag, start, start.slice(0, 11) + '23:00:00');
}

function moscowNow(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000 + 3 * 3600000);
  return d.toISOString().slice(0, 11) + '12:00:00';
}

const auth = () => ({ authorization: 'tma ' + initDataFor({ id: 111, first_name: 'Михаил', username: 'mytolstoy' }) });

test('офис: регистрации без повторов, план, будущие события и Туризм', async (t) => {
  const { sqlite, env } = eventsEnv(t);
  addEvent(sqlite, 'future', 'Будущее', moscowNow(5));
  addEvent(sqlite, 'turizm-trip', 'Поездка', moscowNow(10), 'Туризм');
  addEvent(sqlite, 'old', 'Давнее', '2020-01-10T10:00:00');
  const ins = sqlite.prepare("INSERT INTO event_signups (event_id, source, tg_user_id, username, person_name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, '2026')");
  ins.run('future', 'bot', 1, 'ivan', 'Иван', null);
  ins.run('future', 'site', null, 'ivan', 'Иван', '79990000000'); // тот же человек — не дубль
  ins.run('future', 'site', null, null, 'Пётр', '79991111111');
  ins.run('future', 'manual', null, 'olga', 'Ольга', null);
  sqlite.prepare("INSERT INTO touches (kind, note, person_name, person_username) VALUES ('event_signup', 'Будущее', 'Анна', 'anna')").run();

  const resp = await worker.fetch(new Request('https://codrosta.club/api/office/data', { headers: auth() }), env, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const ids = body.events.map((e) => e.id);
  assert.deepEqual(ids, ['future', 'turizm-trip']); // давнее (не этого месяца) не приходит
  const future = body.events[0];
  assert.equal(future.registered, 4); // Иван, Пётр, Ольга, Анна
  assert.equal(future.plan, null);
  assert.match(future.start, /\+03:00$/);
  assert.equal(body.events[1].turizm, true);
  assert.equal(body.user.firstName, 'Михаил');
});

test('офис: план сохраняется (колонка добавляется сама), неверный — 400, чужой — 403', async (t) => {
  const { sqlite, env } = eventsEnv(t);
  addEvent(sqlite, 'future', 'Будущее', moscowNow(5));
  const post = (body, headers = auth()) => worker.fetch(new Request('https://codrosta.club/api/office/event-plan', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, {});

  assert.equal((await post({ eventId: 'future', plan: 0 })).status, 400);
  assert.equal((await post({ eventId: 'future', plan: 2.5 })).status, 400);
  assert.equal((await post({ eventId: 'nope', plan: 10 })).status, 404);
  assert.equal((await post({ eventId: 'future', plan: 10 }, { authorization: 'tma ' + initDataFor({ id: 999, username: 'x' }) })).status, 403);
  const ok = await post({ eventId: 'future', plan: 15 });
  assert.equal(ok.status, 200);
  assert.equal((await getEventById(env.DB, 'future')).plan, 15);

  const data = await (await worker.fetch(new Request('https://codrosta.club/api/office/data', { headers: auth() }), env, {})).json();
  assert.equal(data.events[0].plan, 15);
  assert.equal((await post({ eventId: 'future', plan: null })).status, 200);
  assert.equal((await getEventById(env.DB, 'future')).plan, null);
});

const TEMPLATE = (plan) => `Дата: 20 декабря
Время: 18:00 — 20:00
Место проведения (название): Офис
Адрес: ул. Ленина, 1
Название мероприятия: Тестовая встреча
Категория: Нетворкинг
${plan === undefined ? '' : 'План участников (сколько человек хотим собрать, числом): ' + plan + '\n'}Описание: Короткое описание.

Регистрация:`;

test('шаблон: «План участников» разбирается и не попадает в описание', () => {
  const r = parseEventMessage(TEMPLATE(25));
  assert.equal(r.ok, true);
  assert.equal(r.event.plan, 25);
  assert.equal(r.event.description, 'Короткое описание.');
  assert.equal(parseEventMessage(TEMPLATE('')).event.plan, null);
  assert.equal(parseEventMessage(TEMPLATE(undefined)).event.plan, undefined);
  const bad = parseEventMessage(TEMPLATE('двадцать'));
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.some((m) => m.startsWith('План участников')));
});

test('шаблон: план сохраняется при создании, показывается при редактировании и не стирается старым текстом', async (t) => {
  const { env } = eventsEnv(t);
  const id = await insertEvent(env.DB, parseEventMessage(TEMPLATE(25)).event, 'mytolstoy');
  let e = await getEventById(env.DB, id);
  assert.equal(e.plan, 25);
  assert.match(renderEventTemplate(e), /^План участников: 25$/m);
  // правка текстом без строки плана — план остаётся
  await updateEvent(env.DB, id, parseEventMessage(TEMPLATE(undefined)).event);
  assert.equal((await getEventById(env.DB, id)).plan, 25);
  // отредактировали «как сейчас» с новым числом
  await updateEvent(env.DB, id, parseEventMessage(renderEventTemplate(e).replace('План участников: 25', 'План участников: 30')).event);
  e = await getEventById(env.DB, id);
  assert.equal(e.plan, 30);
});

test('бот «Список участников» после выноса подсчёта: те же 4 записи, что в офисе', async (t) => {
  const { handleTelegramUpdate } = await import('../src/engagement.js');
  const { sqlite, env } = eventsEnv(t);
  sqlite.exec(`CREATE TABLE pending_edits (telegram_user_id INTEGER PRIMARY KEY, section TEXT, created_at TEXT);`);
  addEvent(sqlite, 'future', 'Будущее', moscowNow(5));
  const ins = sqlite.prepare("INSERT INTO event_signups (event_id, source, tg_user_id, username, person_name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, '2026')");
  ins.run('future', 'bot', 1, 'ivan', 'Иван', null);
  ins.run('future', 'site', null, 'ivan', 'Иван', '79990000000');
  ins.run('future', 'site', null, null, 'Пётр', '79991111111');
  ins.run('future', 'manual', null, 'olga', 'Ольга', null);
  sqlite.prepare("INSERT INTO touches (kind, note, person_name, person_username) VALUES ('event_signup', 'Будущее', 'Анна', 'anna')").run();
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/sendMessage')) sent.push(JSON.parse(options.body).text);
    return Response.json({ ok: true, result: { type: 'web_app', web_app: { url: 'https://codrosta.club/office' } } });
  });
  await handleTelegramUpdate({ callback_query: { id: 'q', from: { id: 111, username: 'mytolstoy' }, data: 'es:future' } }, env);
  const text = sent.join('\n');
  assert.match(text, /ИТОГО участников: 4/);
  assert.match(text, /Через бота \(ссылка\): 1/);
  assert.match(text, /С сайта: 2/);
  assert.match(text, /Добавлены вручную: 1/);
  assert.match(text, /✅ Иван/);
});

// ---- Этап 4: деньги -------------------------------------------------------------
import { monthWeeks, moscowDay } from '../src/office-money.js';

function moneyEnv(t) {
  const { sqlite, env } = eventsEnv(t);
  // D1 batch — одной транзакцией
  env.DB.batch = async (stmts) => {
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  };
  return { sqlite, env };
}

function call(env, path, body, who = { id: 111, first_name: 'Михаил', username: 'mytolstoy' }) {
  const headers = { authorization: 'tma ' + initDataFor(who) };
  const init = body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
  return worker.fetch(new Request('https://codrosta.club' + path, init), env, {});
}

test('недели октября 2026: 1–4, 5–11, 12–18, 19–25, 26–31', () => {
  assert.deepEqual(monthWeeks('2026-10').map((w) => w.from.slice(8) + '–' + w.to.slice(8)), ['01–04', '05–11', '12–18', '19–25', '26–31']);
  assert.equal(monthWeeks('2026-02').at(-1).to, '2026-02-28');
});

test('продажи: итоги месяца = сумма недель = сумма статей; отмена и повтор', async (t) => {
  const { env } = moneyEnv(t);
  const kodrosta = { id: 222, first_name: 'Код Роста', username: 'Kodrosta' };
  const add = (clientId, date, rub, source, extra = {}) => call(env, '/api/office/sales', { clientId, date, amountKop: rub * 100, source, ...extra }, kodrosta);

  assert.equal((await add('a1', '2026-09-01', 50000, 'new')).status, 200);
  assert.equal((await add('a2', '2026-09-04', 25000, 'renewal')).status, 200);
  assert.equal((await add('a3', '2026-09-07', 15000, 'events', { eventId: 'x', comment: 'Иванов, бизнес-баня' })).status, 200);
  assert.equal((await add('a4', '2026-09-30', 7000, 'ads')).status, 200);
  assert.equal((await add('a5', '2026-10-01', 999, 'ads')).status, 200); // октябрь — в сентябрь не входит
  // двойное нажатие / повтор после потери сети — та же форма, дубля нет
  const again = await (await add('a1', '2026-09-01', 50000, 'new')).json();
  assert.equal(again.duplicate, true);
  // ошибочная запись — отменяем
  const wrong = await (await add('a6', '2026-09-02', 100000, 'new')).json();
  assert.equal((await call(env, '/api/office/sales/void', { id: wrong.id })).status, 200);

  const m = (await (await call(env, '/api/office/money?month=2026-09')).json()).money;
  assert.equal(m.factKop, 97000 * 100);
  assert.equal(m.weeks.reduce((a, w) => a + w.factKop, 0), m.factKop);
  assert.equal(m.sources.reduce((a, s) => a + s.factKop, 0), m.factKop);
  assert.deepEqual(m.weeks.map((w) => w.factKop / 100), [75000, 15000, 0, 0, 7000]);
  assert.deepEqual(m.weeks[0].bySource.map((v) => v / 100), [50000, 25000, 0, 0]);
  assert.deepEqual(m.sources.map((s) => s.factKop / 100), [50000, 25000, 15000, 7000]);
  assert.equal(m.planKop, null); // план не задан — не ноль
  assert.equal(m.sales.length, 5);
  const voided = m.sales.find((s) => s.id === wrong.id);
  assert.equal(voided.voided, true);
  assert.equal(voided.voidedBy, 'mytolstoy');
  assert.equal(m.sales.find((s) => s.source === 'new' && !s.voided).createdBy, 'kodrosta');
});

test('продажи: неверные данные отклоняются', async (t) => {
  const { env } = moneyEnv(t);
  const bad = async (body) => (await call(env, '/api/office/sales', { clientId: 'c' + Math.random(), date: '2026-10-01', amountKop: 100, source: 'new', ...body })).status;
  assert.equal(await bad({ amountKop: 0 }), 400);
  assert.equal(await bad({ amountKop: -500 }), 400);
  assert.equal(await bad({ amountKop: 10.5 }), 400);
  assert.equal(await bad({ source: 'other' }), 400);
  assert.equal(await bad({ date: '2026-02-30' }), 400);
  assert.equal(await bad({ date: '2999-01-01' }), 400); // будущее — денег ещё нет
  assert.equal(await bad({ clientId: '' }), 400);
  const stranger = await call(env, '/api/office/sales', { clientId: 'z', date: '2026-10-01', amountKop: 100, source: 'new' }, { id: 999, username: 'x' });
  assert.equal(stranger.status, 403);
});

test('планы: месяц = сумма статей, недели отдельно, снятие плана', async (t) => {
  const { env } = moneyEnv(t);
  const save = (body) => call(env, '/api/office/plans', { month: '2026-10', ...body });
  assert.equal((await save({ sources: { new: 200000_00, renewal: 150000_00, events: 100000_00, ads: null }, weeks: [90000_00, 110000_00, 100000_00, 90000_00, 60000_00] })).status, 200);
  let m = (await (await call(env, '/api/office/money?month=2026-10')).json()).money;
  assert.equal(m.planKop, 450000_00);
  assert.deepEqual(m.sources.map((s) => s.planKop), [200000_00, 150000_00, 100000_00, null]);
  assert.deepEqual(m.weeks.map((w) => w.planKop / 100), [90000, 110000, 100000, 90000, 60000]);
  // снять план недели и статьи
  assert.equal((await save({ sources: { new: 200000_00, renewal: null, events: null, ads: null }, weeks: [null, 1000_00] })).status, 200);
  m = (await (await call(env, '/api/office/money?month=2026-10')).json()).money;
  assert.equal(m.planKop, 200000_00);
  assert.deepEqual(m.weeks.map((w) => w.planKop), [null, 1000_00, null, null, null]);
  assert.equal((await save({ sources: { new: -1 } })).status, 400);
  assert.equal((await save({ weeks: [1, 2, 3, 4, 5, 6] })).status, 400); // в октябре 5 недель
  assert.equal((await call(env, '/api/office/plans', { month: '2026-13', sources: {} })).status, 400);
  // ноябрь отдельно
  m = (await (await call(env, '/api/office/money?month=2026-11')).json()).money;
  assert.equal(m.planKop, null);
});

test('/api/office/data отдаёт деньги текущего месяца по Москве', async (t) => {
  const { env } = moneyEnv(t);
  await call(env, '/api/office/sales', { clientId: 'today', date: moscowDay(new Date()), amountKop: 123456, source: 'ads' });
  const d = await (await call(env, '/api/office/data')).json();
  assert.equal(d.money.month, d.month);
  assert.equal(d.money.factKop, 123456);
});

// ---- 9 октября: строки плана и расходы ---------------------------------------

test('план из строк «сколько × почём»: статья = сумма строк, прежняя сумма снимается', async (t) => {
  const { sqlite, env } = moneyEnv(t);
  addEvent(sqlite, 'banya', 'Бизнес-баня', '2026-10-08T18:00:00');
  // старый план одной суммой
  await call(env, '/api/office/plans', { month: '2026-10', sources: { new: 250000_00, renewal: 150000_00, events: 340000_00, ads: null } });
  let m = (await (await call(env, '/api/office/money?month=2026-10')).json()).money;
  assert.equal(m.planKop, 740000_00);
  assert.deepEqual(m.sources[2].items, []);

  const resp = await call(env, '/api/office/plans', { month: '2026-10', weeks: [100000_00], items: {
    new: [{ title: 'Новые резиденты', qty: 10, priceKop: 25000_00 }],
    renewal: [{ title: 'Продления', qty: 10, priceKop: 15000_00 }],
    events: [
      { eventId: 'banya', title: 'Бизнес-баня', qty: 8, priceKop: 15000_00 },
      { title: 'Рубеж', qty: 10, priceKop: 12000_00 },
      { title: 'Калориметр', qty: 20, priceKop: 5000_00 },
    ],
  } });
  assert.equal(resp.status, 200);
  m = (await (await call(env, '/api/office/money?month=2026-10')).json()).money;
  const ev = m.sources.find((x) => x.key === 'events');
  assert.equal(ev.planKop, (8 * 15000 + 10 * 12000 + 20 * 5000) * 100); // 340 000
  assert.equal(ev.items[0].eventTitle, 'Бизнес-баня');
  assert.equal(ev.items[0].totalKop, 120000_00);
  assert.equal(m.sources.find((x) => x.key === 'ads').planKop, null); // ни строк, ни суммы
  assert.equal(m.planKop, (250000 + 150000 + 340000) * 100);
  assert.equal(m.weeks[0].planKop, 100000_00);
  // неверные строки
  assert.equal((await call(env, '/api/office/plans', { month: '2026-10', items: { new: [{ qty: 0, priceKop: 100 }] } })).status, 400);
  assert.equal((await call(env, '/api/office/plans', { month: '2026-10', items: { new: [{ qty: 2, priceKop: -1 }] } })).status, 400);
  // повторное сохранение заменяет строки, а не дописывает
  await call(env, '/api/office/plans', { month: '2026-10', items: { new: [{ qty: 1, priceKop: 100 }] } });
  m = (await (await call(env, '/api/office/money?month=2026-10')).json()).money;
  assert.equal(m.planKop, 100);
});

test('расходы: комиссия и себестоимость по мероприятиям, отмена, повтор, обязательное мероприятие', async (t) => {
  const { sqlite, env } = moneyEnv(t);
  addEvent(sqlite, 'banya', 'Бизнес-баня', '2026-09-20T18:00:00');
  const exp = (body) => call(env, '/api/office/expenses', { date: '2026-09-15', ...body });
  assert.equal((await exp({ clientId: 'e1', amountKop: 30000_00, category: 'event_cost', eventId: 'banya' })).status, 200);
  assert.equal((await exp({ clientId: 'e2', amountKop: 9000_00, category: 'commission', comment: 'Анна, 10%' })).status, 200);
  assert.equal((await (await exp({ clientId: 'e2', amountKop: 9000_00, category: 'commission' })).json()).duplicate, true);
  assert.equal((await exp({ clientId: 'e3', amountKop: 100, category: 'event_cost' })).status, 400); // без мероприятия
  assert.equal((await exp({ clientId: 'e4', amountKop: 100, category: 'rent' })).status, 400);
  const wrong = await (await exp({ clientId: 'e5', amountKop: 777_00, category: 'commission' })).json();
  assert.equal((await call(env, '/api/office/expenses/void', { id: wrong.id })).status, 200);

  const m = (await (await call(env, '/api/office/money?month=2026-09')).json()).money;
  assert.equal(m.expenses.totalKop, 39000_00);
  assert.deepEqual(m.expenses.categories.map((c) => c.factKop), [9000_00, 30000_00]);
  assert.deepEqual(m.expenses.byEvent, [{ eventId: 'banya', eventTitle: 'Бизнес-баня', factKop: 30000_00 }]);
  assert.equal(m.expenses.list.length, 3);
  assert.equal(m.expenses.list.find((x) => x.id === wrong.id).voided, true);
  assert.equal(m.factKop, 0); // расходы не путаются с поступлениями
});
