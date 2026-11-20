import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {assetCandidates, contentTypeFor, sanitizeHtml} from '../production-static.mjs';
import {dueCrons} from '../scheduler.mjs';
import {allowedOrigins, buildSslConfig, loadEnv} from '../env-production.mjs';
import {translate} from '../postgres.mjs';

const baseEnv = {
  DATABASE_URL: 'postgresql://site_app:test@localhost:5432/kodrosta_site',
  BOT_TOKEN: '123456:test',
  CHAT_ID: '-1001234567890',
  ADMIN_USERNAMES: 'mytolstoy,Kodrosta',
  ADMISSION_EVENT_ID: 'premiya-2026',
  ADMISSION_OWNER_USERNAME: 'mytolstoy',
  ADMISSION_SHEET_ID: 'sheet-admission',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({client_email: 'test@example.com', private_key: 'test'}),
  GOOGLE_SHEET_ID: 'sheet-residents',
  METRIKA_TOKEN: 'metrika-token',
  METRIKA_REPORT_KEY: 'report-key',
  EXPORT_KEY: 'export-key',
  RESIDENTS_CHAT_ID: '-1002274713400',
};

test('asset candidates cover clean URLs and block traversal', () => {
  assert.deepEqual(assetCandidates('/'), ['index.html']);
  assert.deepEqual(assetCandidates('/premiya'), ['premiya', 'premiya.html', 'premiya/index.html']);
  assert.deepEqual(assetCandidates('/blog/foo'), ['blog/foo', 'blog/foo.html', 'blog/foo/index.html']);
  assert.deepEqual(assetCandidates('/blog/'), ['blog', 'blog.html', 'blog/index.html']);
  assert.deepEqual(assetCandidates('/assets/a.png'), ['assets/a.png']);
  assert.deepEqual(assetCandidates('/../etc/passwd'), []);
  assert.deepEqual(assetCandidates('/%2e%2e/etc'), []);
  assert.deepEqual(assetCandidates('/a%5c..%5cb'), []);
  assert.deepEqual(assetCandidates('relative'), []);
});

test('html keeps Yandex Metrika but removes Cloudflare beacon', () => {
  const html = '<html><head><script src="https://static.cloudflareinsights.com/beacon.min.js"></script>' +
    '<script src="https://mc.yandex.ru/metrika/tag.js"></script></head><body><p>ok</p></body></html>';
  const out = sanitizeHtml(html);
  assert.equal(out.includes('cloudflareinsights'), false);
  assert.equal(out.includes('mc.yandex.ru'), true);
  assert.equal(out.includes('<p>ok</p>'), true);
});

test('content types cover production static files', () => {
  assert.match(contentTypeFor('index.html'), /text\/html/);
  assert.match(contentTypeFor('sitemap.xml'), /application\/xml/);
  assert.equal(contentTypeFor('photo.webp'), 'image/webp');
  assert.equal(contentTypeFor('file.unknown'), 'application/octet-stream');
});

test('scheduler maps UTC minutes to Cloudflare cron strings', () => {
  assert.deepEqual(dueCrons(new Date('2026-11-20T03:00:00Z')), ['*/15 * * * *', '0 3 * * *']);
  assert.deepEqual(dueCrons(new Date('2026-11-23T07:00:00Z')), ['*/15 * * * *', '0 7 * * 1']);
  assert.deepEqual(dueCrons(new Date('2026-12-01T06:00:00Z')), ['*/15 * * * *', '0 6 1 * *']);
  assert.deepEqual(dueCrons(new Date('2026-11-20T03:01:00Z')), []);
  assert.deepEqual(dueCrons(new Date('2026-11-20T03:15:00Z')), ['*/15 * * * *']);
});

test('production env requires real values and rejects demo event', () => {
  const env = loadEnv(baseEnv);
  assert.equal(env.PUBLIC_ORIGIN, 'https://codrosta.club');
  assert.equal(env.PORT, 8080);
  assert.equal(env.DISABLE_SCHEDULER, false);
  assert.equal(loadEnv({...baseEnv, DISABLE_SCHEDULER: '1'}).DISABLE_SCHEDULER, true);
  assert.throws(() => loadEnv({}), /DATABASE_URL/);
  assert.throws(() => loadEnv({...baseEnv, ADMISSION_EVENT_ID: 'premiya-2026-demo'}), /demo/);
  assert.throws(() => loadEnv({...baseEnv, GOOGLE_SERVICE_ACCOUNT_JSON: 'not json'}), /valid JSON/);
  assert.throws(() => loadEnv({...baseEnv, RESIDENTS_CHAT_ID: 'abc'}), /numeric/);
});

test('PostgreSQL TLS requires CA or explicit require mode', async () => {
  assert.deepEqual(buildSslConfig({PGSSL: 'require'}), {rejectUnauthorized: false});
  assert.throws(() => buildSslConfig({}), /PG_CA_PATH/);
  const dir = await mkdtemp(join(tmpdir(), 'kodrosta-ca-'));
  try {
    const file = join(dir, 'CA.pem');
    await writeFile(file, 'CA');
    assert.deepEqual(buildSslConfig({PG_CA_PATH: file}), {ca: 'CA', rejectUnauthorized: true});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('allowed origins include www for the main domain', () => {
  const origins = allowedOrigins('https://codrosta.club');
  assert.equal(origins.has('https://codrosta.club'), true);
  assert.equal(origins.has('https://www.codrosta.club'), true);
  assert.equal(origins.has('https://evil.example'), false);
});

test('all schema migrations translate to PostgreSQL', async () => {
  const dir = resolve(import.meta.dirname, '../../migrations');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(files.length >= 18);
  for (const file of files) {
    const out = translate(await readFile(resolve(dir, file), 'utf8')).text;
    assert.ok(out.trim().length > 0, file);
    const code = out.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/AUTOINCREMENT/i.test(code), false, file);
    assert.equal(/INSERT\s+OR\s+IGNORE/i.test(code), false, file);
    assert.equal(/PRAGMA\s+/i.test(code), false, file);
  }
});
