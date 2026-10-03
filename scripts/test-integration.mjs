import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { buildSubscriptionReportForMonth, listReportMonths, listNewMembersThisMonth, listLeftMembersThisMonth } from '../src/subscriptions.js';

const html = readFileSync(new URL('../turizm.html', import.meta.url), 'utf8');
for (const [slug, title] of [['konferenciya', 'Полная загрузка'], ['sezd', '20 октября'], ['nominaciya', '27 ноября']]) {
  test(`прямая ссылка Туризма ${slug}: OG, карточка и ресурсы`, async () => {
    const env = { ASSETS: { fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/turizm');
      return new Response(html);
    } } };
    const response = await worker.fetch(new Request(`https://codrosta.club/turizm/${slug}`), env, {});
    assert.equal(response.status, 200);
    const result = await response.text();
    assert.ok(result.includes(title));
    assert.ok(result.includes(`content="https://codrosta.club/turizm/${slug}"`));
    assert.ok(result.includes(`<body data-share-event="${slug}">`));
    assert.ok(result.includes('href="/css/turizm.css"'));
    assert.ok(result.includes('src="/js/main.js"'));
    assert.ok(result.includes('href="https://codrosta.club/turizm"'));
  });
}
test('неизвестный URL Туризма сохраняет ответ assets', async () => {
  const response = await worker.fetch(new Request('https://codrosta.club/turizm/unknown'), { ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } }, {});
  assert.equal(response.status, 404);
});

const header = ['', 'Дата начала', 'Дата окончания', 'Дата продления', 'Дата окончания', 'Статус', '', 'ФИО', '', '', '', '', 'Мобильный телефон', '', '', '', 'Телеграм username'];
function row(name, start, end, status = '', renewal = '', renewedEnd = '') {
  const values = Array(17).fill('');
  values[1] = start; values[2] = end; values[3] = renewal; values[4] = renewedEnd;
  values[5] = status; values[7] = name; values[16] = '@fixture'; return values;
}
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const encoded = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
const credentials = JSON.stringify({ client_email: 'integration@example.invalid', private_key: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` });
function fixture(t, rows) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE residents (telegram_username TEXT, chat_id INTEGER); INSERT INTO residents VALUES ('kodrosta', 123);");
  sqlite.exec(readFileSync(new URL('../migrations/0006_cron_log.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = { prepare(sql) { const statement = sqlite.prepare(sql); let values = []; return {
    bind(...args) { values = args; return this; },
    async all() { return { results: statement.all(...values) }; },
    async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; }
  }; } };
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture' });
    if (url.startsWith('https://sheets.googleapis.com/')) return Response.json({ values: rows });
    if (url.startsWith('https://api.telegram.org/botfixture-not-a-token/')) {
      sent.push(JSON.parse(options.body)); return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    throw new Error('Запрещён незамоканный сетевой запрос');
  });
  return { sqlite, sent, env: { DB, BOT_TOKEN: 'fixture-not-a-token', SUBSCRIPTION_ALERT_USERNAME: 'Kodrosta', GOOGLE_SERVICE_ACCOUNT_JSON: credentials, GOOGLE_SHEET_ID: 'fixture' } };
}
async function scheduled(env, cron, time) {
  const jobs = [];
  await worker.scheduled({ cron, scheduledTime: Date.parse(time) }, env, { waitUntil: task => jobs.push(task) });
  await Promise.all(jobs);
}
test('сохранены серверные отчёты, кнопочные выборки и месяцы 2023 года', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-23T08:00:00Z'));
  const data = [header, row('Новый тестовый', '02.09.2026', '02.09.2027'), row('Ушедший тестовый', '01.01.2025', '10.09.2026', 'отказ'), row('Продливший тестовый', '01.01.2025', '10.09.2026', '', '11.09.2026', '11.09.2027')];
  const f = fixture(t, data);
  const report = await buildSubscriptionReportForMonth(f.env, '2026-09');
  for (const name of ['Новый тестовый', 'Ушедший тестовый', 'Продливший тестовый']) assert.ok(report.includes(name));
  assert.ok((await listNewMembersThisMonth(f.env)).includes('Новый тестовый'));
  assert.ok((await listLeftMembersThisMonth(f.env)).includes('Ушедший тестовый'));
  assert.equal(listReportMonths(2023).length, 12);
  assert.equal(listReportMonths(2023)[0].key, '2023-01');
});
test('cron повторов запускает расширенное продление без повторной доставки', async t => {
  const f = fixture(t, [header, row('Неделя тестовая', '01.01.2025', '30.09.2026')]);
  for (const time of ['05:00', '05:15', '05:30']) await scheduled(f.env, '0,15,30 5 * * *', `2026-09-23T${time}:00Z`);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].text.includes('НЕДЕЛЯ'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM cron_runs WHERE job = ?').get('subscriptions').count, 3);
});
test('cron первого числа отправляет серверный месячный отчёт', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T06:00:00Z'));
  const f = fixture(t, [header, row('Новый тестовый', '02.09.2026', '02.09.2027')]);
  await scheduled(f.env, '0 6 1 * *', '2026-10-01T06:00:00Z');
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].text.includes('Новый тестовый'));
  assert.equal(f.sqlite.prepare('SELECT job FROM cron_runs').get().job, 'subscriptions_monthly');
});
test('Метрика в 10:00 МСК маршрутизируется независимо от синхронизации', async t => {
  const f = fixture(t, [header]);
  await scheduled(f.env, '0 7 * * 1', '2026-10-05T07:00:00Z');
  assert.equal(f.sqlite.prepare('SELECT job FROM cron_runs').get().job, 'metrika_digest');
  assert.equal(f.sent.length, 0);
});
