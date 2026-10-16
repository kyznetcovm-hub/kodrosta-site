// Тесты записи на мероприятие: текст подтверждения при записи через бота
// (описание + ссылка) и то, что запись с сайта по-прежнему доходит до группы.
// Запуск: node --test scripts/test-event-signup-notify.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { sendEventReminders } from '../src/engagement.js';

const GROUP = -100500;
const LINK = 'https://telemost.360.yandex.ru/j/3841796847';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_engagement.sql', '0002_events.sql', '0003_content.sql', '0006_event_signups.sql', '0006_cron_log.sql']) {
    sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  }
  sqlite.exec(`INSERT INTO residents (full_name, phone, telegram_username, chat_id) VALUES ('Резидент Тестовый', '79001112233', 'resident1', 555);
    INSERT INTO residents (full_name, phone, telegram_username) VALUES ('Резидент Без Бота', '79004445566', 'nobot');
    INSERT INTO events (id, title, tag, start, end, place, description, register_url, created_at)
      VALUES ('podcast', 'ИИ-созвон', 'Подкаст', '2026-10-13T18:00:00', '2026-10-13T19:00:00', 'Онлайн', 'Что нового в ИИ за неделю.', '${LINK}', '2026-10-01T00:00:00Z'),
             ('chat-ev', 'Встреча', 'Нетворкинг', '2026-10-14T18:00:00', '2026-10-14T20:00:00', 'Офис', 'Знакомимся.', 'https://t.me/+abc', '2026-10-01T00:00:00Z');`);
  t.after(() => sqlite.close());
  const DB = { prepare(sql) { const statement = sqlite.prepare(sql); let values = []; return {
    bind(...args) { values = args; return this; },
    async first() { return statement.get(...values) ?? null; },
    async all() { return { results: statement.all(...values) }; },
    async run() { const r = statement.run(...values); return { meta: { changes: Number(r.changes) } }; },
  }; } };
  const sent = [];
  const state = { status: 200 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/botfixture-not-a-token/')) {
      sent.push({ method: String(url).split('/').pop(), ...JSON.parse(options.body) });
      return Response.json({ ok: state.status === 200 }, { status: state.status });
    }
    throw new Error('Запрещён незамоканный сетевой запрос: ' + url);
  });
  return { sqlite, sent, state, env: { DB, BOT_TOKEN: 'fixture-not-a-token', CHAT_ID: String(GROUP) } };
}

function submit(env, fields) {
  return worker.fetch(new Request('https://codrosta.club/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'event', event: 'ИИ-созвон', eventId: 'podcast', comment: '', ...fields }),
  }), env, {});
}

const dms = (sent, chatId) => sent.filter(m => m.method === 'sendMessage' && Number(m.chat_id) === chatId);

test('запись на сайте: заявка уходит в группу, личных сообщений бот не шлёт', async t => {
  const f = fixture(t);
  const resp = await submit(f.env, { name: 'Резидент Тестовый', phone: '+7 900 111-22-33', telegram: '@resident1' });
  assert.deepEqual(await resp.json(), { ok: true });
  assert.equal(dms(f.sent, GROUP).length, 1);
  assert.equal(f.sent.filter(m => Number(m.chat_id) !== GROUP).length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS c FROM event_signups WHERE event_id = 'podcast'").get().c, 1);
});

test('запись через бота: подтверждение содержит описание и ссылку; чат t.me подписан как чат', async t => {
  const f = fixture(t);
  async function press(eventId, userId) {
    f.sent.length = 0;
    const update = { callback_query: { id: 'cq1', from: { id: userId, username: 'guest2', first_name: 'Гость' }, data: 'sreg:' + eventId, message: { chat: { id: userId } } } };
    await worker.fetch(new Request('https://codrosta.club/api/telegram-webhook', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update),
    }), f.env, {});
    return dms(f.sent, userId)[0];
  }
  const first = await press('podcast', 888);
  assert.ok(first.text.startsWith('✅ Готово, вы записаны!'));
  assert.ok(first.text.includes('Что нового в ИИ за неделю.'));
  assert.ok(first.text.includes('🔗 Ссылка: ' + LINK));
  const again = await press('podcast', 888);
  assert.ok(again.text.startsWith('Вы уже в списке'));
  const chat = await press('chat-ev', 888);
  assert.ok(chat.text.includes('💬 Чат мероприятия: https://t.me/+abc'));
});

test('/start apply (кнопка после заявки на вступление): приветствие и ближайшие мероприятия клуба без «Туризма»', async t => {
  const f = fixture(t);
  f.sqlite.exec(`INSERT INTO events (id, title, tag, start, end, place, description, created_at) VALUES
    ('club-future', 'Будущая встреча клуба', 'Нетворкинг', '2030-01-10T18:00:00', '2030-01-10T20:00:00', 'Офис', 'Текст.', '2026-10-01T00:00:00Z'),
    ('tur-future', 'Событие туризма', 'Туризм', '2030-01-11T18:00:00', '2030-01-11T20:00:00', 'Лес', 'Текст.', '2026-10-01T00:00:00Z');`);
  const update = { message: { message_id: 1, from: { id: 999, username: 'prospect', first_name: 'Гость' }, chat: { id: 999, type: 'private' }, text: '/start apply' } };
  await worker.fetch(new Request('https://codrosta.club/api/telegram-webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update),
  }), f.env, {});
  const [dm] = dms(f.sent, 999);
  assert.ok(dm, 'бот не ответил');
  assert.ok(dm.text.includes('Заявку, оставленную на сайте'));
  assert.ok(dm.text.includes('https://codrosta.club/e/club-future'));
  assert.ok(!dm.text.includes('tur-future') && !dm.text.includes('Событие туризма'));
  assert.ok(!dm.text.includes('контакт'), 'не должен просить контакт для учёта активности');
});

// --- Напоминания: за сутки и за час -------------------------------------------
// Мероприятие 'podcast' начинается 13.10.2026 18:00 по Москве = 15:00 UTC.
const T_DAY = Date.parse('2026-10-12T15:10:00Z');    // за 23 ч 50 мин
const T_HOUR = Date.parse('2026-10-13T14:10:00Z');   // за 50 мин

function addSignups(f) {
  f.sqlite.exec(`INSERT INTO event_signups (event_id, source, tg_user_id, username, created_at) VALUES
      ('podcast', 'bot', 777, 'early', '2026-10-02T10:00:00Z'),
      ('podcast', 'bot', 778, 'late', '2026-10-13T10:00:00Z');
    INSERT INTO event_signups (event_id, source, username, resident_id, created_at) VALUES
      ('podcast', 'site', 'resident1', 1, '2026-10-03T10:00:00Z'),
      ('podcast', 'site', 'nobot', 2, '2026-10-03T10:00:00Z'),
      ('podcast', 'manual', 'someone', NULL, '2026-10-03T10:00:00Z');`);
}
const to = (f, id) => f.sent.filter(m => Number(m.chat_id) === id);

test('напоминание за сутки: записавшимся заранее (бот и резидент с chat_id), без дублей и без поздних', async t => {
  const f = fixture(t); addSignups(f);
  assert.equal(await sendEventReminders(f.env, T_DAY), 2);
  assert.equal(to(f, 777).length, 1);
  assert.equal(to(f, 555).length, 1, 'резидент с chat_id, записавшийся на сайте');
  assert.equal(to(f, 778).length, 0, 'записался позже чем за сутки — «завтра» было бы неточно');
  assert.ok(to(f, 777)[0].text.includes('завтра'));
  assert.ok(to(f, 777)[0].text.includes('13 октября, 18:00'));
  assert.ok(to(f, 777)[0].text.includes(LINK));
  assert.equal(await sendEventReminders(f.env, T_DAY + 15 * 60000), 0, 'повторный запуск cron не дублирует');
});

test('напоминание за час: всем записавшимся, поздним тоже; суточное повторно не шлётся', async t => {
  const f = fixture(t); addSignups(f);
  await sendEventReminders(f.env, T_DAY);
  f.sent.length = 0;
  assert.equal(await sendEventReminders(f.env, T_HOUR), 3);
  assert.deepEqual(f.sent.map(m => Number(m.chat_id)).sort(), [555, 777, 778]);
  assert.ok(f.sent[0].text.startsWith('⏰ Через час начинаем!'));
  assert.ok(!f.sent[0].text.includes('Что нового в ИИ'), 'в напоминании нет длинного описания');
});

test('напоминаний нет: мероприятие далеко, уже началось или нет получателей', async t => {
  const f = fixture(t); addSignups(f);
  assert.equal(await sendEventReminders(f.env, Date.parse('2026-10-11T00:00:00Z')), 0);
  assert.equal(await sendEventReminders(f.env, Date.parse('2026-10-13T15:30:00Z')), 0);
  assert.equal(f.sent.length, 0);
});

test('сбой Telegram (5xx): напоминание повторится при следующем запуске; бот заблокирован (403) — нет', async t => {
  const f = fixture(t); addSignups(f);
  f.state.status = 500;
  assert.equal(await sendEventReminders(f.env, T_DAY), 0);
  f.state.status = 200; f.sent.length = 0;
  assert.equal(await sendEventReminders(f.env, T_DAY + 15 * 60000), 2, 'после сбоя доставлено');
  const g = fixture(t); addSignups(g);
  g.state.status = 403;
  await sendEventReminders(g.env, T_DAY);
  g.state.status = 200; g.sent.length = 0;
  assert.equal(await sendEventReminders(g.env, T_DAY + 15 * 60000), 0, '403 не повторяем');
});

test('cron */15 запускает напоминания, а не синхронизацию таблицы', async t => {
  const f = fixture(t); addSignups(f);
  const jobs = [];
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: T_DAY }, f.env, { waitUntil: p => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(to(f, 777).length, 1);
  assert.equal(f.sqlite.prepare('SELECT job FROM cron_runs').get().job, 'event_reminders');
});

test('в заявках для группы username всегда с @ (кликабельный), даже если человек ввёл без неё', async t => {
  const f = fixture(t);
  const cases = [['mytolstoy', 'Telegram: @mytolstoy'], ['@Guest1', 'Telegram: @Guest1'], ['https://t.me/some_user', 'Telegram: @some_user'], ['t.me/other1', 'Telegram: @other1'], ['+79990001122', 'Telegram: +79990001122']];
  for (const [input] of cases) await submit(f.env, { name: 'Тест', phone: '+79990001122', telegram: input });
  const texts = dms(f.sent, GROUP).map(m => m.text);
  cases.forEach(([, expected], i) => assert.ok(texts[i].includes(expected + '\n'), texts[i]));
  f.sent.length = 0;
  await worker.fetch(new Request('https://codrosta.club/api/submit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'apply', name: 'Тест', phone: '+79990001122', telegram: 'mytolstoy', company: 'ООО' }),
  }), f.env, {});
  assert.ok(dms(f.sent, GROUP)[0].text.includes('Telegram: @mytolstoy\n'));
});

test('заявка партнёра со страницы премии: компания и пакет доходят до группы, касание partner_request', async t => {
  const f = fixture(t);
  const resp = await submit(f.env, {
    type: 'partner', company: 'ООО «Тест»', package: 'Генеральный партнёр — 500 000 ₽',
    name: 'Иван Иванов', phone: '+7 900 111-22-33', telegram: '@ivan_test', comment: 'Хотим свой кейс', event: '', eventId: '',
  });
  assert.deepEqual(await resp.json(), { ok: true });
  const posted = dms(f.sent, GROUP);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /Заявка на партнёрство/);
  assert.match(posted[0].text, /Компания: ООО «Тест»/);
  assert.match(posted[0].text, /Интересует: Генеральный партнёр — 500 000 ₽/);
  assert.match(posted[0].text, /Telegram: @ivan_test/);
  const touch = f.sqlite.prepare("SELECT kind, note FROM touches ORDER BY id DESC LIMIT 1").get();
  assert.equal(touch.kind, 'partner_request');
  assert.match(touch.note, /ООО «Тест»/);
  // в «Списки участников» мероприятий заявка партнёра не попадает
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS c FROM event_signups").get().c, 0);
});

test('заявка партнёра без компании отклоняется и в группу не уходит', async t => {
  const f = fixture(t);
  const resp = await submit(f.env, { type: 'partner', company: ' ', name: 'Иван', phone: '+7 900 111-22-33', telegram: '@ivan_test', event: '', eventId: '' });
  assert.equal(resp.status, 400);
  assert.equal(dms(f.sent, GROUP).length, 0);
});
