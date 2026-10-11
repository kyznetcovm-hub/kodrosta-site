// Тесты записи на мероприятие: текст подтверждения при записи через бота
// (описание + ссылка) и то, что запись с сайта по-прежнему доходит до группы.
// Запуск: node --test scripts/test-event-signup-notify.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const GROUP = -100500;
const LINK = 'https://telemost.360.yandex.ru/j/3841796847';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_engagement.sql', '0002_events.sql', '0003_content.sql', '0006_event_signups.sql']) {
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
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/botfixture-not-a-token/')) {
      sent.push({ method: String(url).split('/').pop(), ...JSON.parse(options.body) });
      return Response.json({ ok: true });
    }
    throw new Error('Запрещён незамоканный сетевой запрос: ' + url);
  });
  return { sqlite, sent, env: { DB, BOT_TOKEN: 'fixture-not-a-token', CHAT_ID: String(GROUP) } };
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
