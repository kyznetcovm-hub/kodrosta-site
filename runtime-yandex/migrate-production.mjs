// Только схема production-БД. Без demo-данных, без initialize.mjs.
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {translate} from './postgres.mjs';
import {buildSslConfig} from './env-production.mjs';

const url = String(process.env.DATABASE_URL_MIGRATIONS || '').trim();
if (!url) {
  console.error('DATABASE_URL_MIGRATIONS is required');
  process.exit(1);
}

const ssl = buildSslConfig({PG_CA_PATH: process.env.PG_CA_PATH, PGSSL: process.env.PGSSL});
const pool = new pg.Pool({connectionString: url, ssl, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 60000});
const migrationsDir = resolve(import.meta.dirname, '../migrations');

let client;
try {
  client = await pool.connect();
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = translate(await readFile(resolve(migrationsDir, file), 'utf8')).text;
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
      await client.query('COMMIT');
      count += 1;
      console.log('migration-applied', file);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('migration-failed', file, error?.code || error?.name || 'Error');
      throw error;
    }
  }
  console.log('migrations-done', {applied: count, total: files.length});
} catch (error) {
  console.error('migrations-aborted', error?.code || error?.name || 'Error');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
