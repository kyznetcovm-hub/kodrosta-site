// Импорт SQLite-дампа D1 в PostgreSQL. Только таблицы сайта, без _cf_KV и erp_*.
// Строки не логируются: только имена таблиц и количества.
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';

const dumpPath = String(process.env.SQLITE_DUMP || '').trim();
const databaseUrl = String(process.env.DATABASE_URL_IMPORT || '').trim();
if (!dumpPath) throw new Error('SQLITE_DUMP is required');
if (!databaseUrl) throw new Error('DATABASE_URL_IMPORT is required');

const ssl = process.env.PG_CA_PATH
  ? {ca: readFileSync(process.env.PG_CA_PATH, 'utf8'), rejectUnauthorized: true}
  : process.env.PGSSL === 'require'
    ? {rejectUnauthorized: false}
    : null;
if (!ssl) throw new Error('Set PG_CA_PATH or PGSSL=require');

const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(dumpPath, 'utf8'));

const tables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name)
  .filter((name) => name !== '_cf_KV' && !name.startsWith('erp_'));

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl,
  max: 1,
  connectionTimeoutMillis: 10000,
  statement_timeout: 120000,
});
const client = await pool.connect();
let imported = 0;
try {
  for (const table of tables) {
    const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => row.name);
    if (!columns.length) throw new Error(`No columns for SQLite table ${table}`);
    const pgColumns = new Set(
      (await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',
        [table],
      )).rows.map((row) => row.column_name),
    );
    const missing = columns.filter((name) => !pgColumns.has(name));
    if (missing.length) throw new Error(`PostgreSQL table ${table} is missing columns: ${missing.join(', ')}`);
    const rows = sqlite.prepare(`SELECT * FROM ${quote(table)}`).all();
    if (!rows.length) {
      console.log('imported', table, 0);
      continue;
    }
    const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns
      .map((_, index) => '$' + (index + 1))
      .join(', ')}) ON CONFLICT DO NOTHING`;
    await client.query('BEGIN');
    try {
      for (const row of rows) {
        const values = columns.map((column) => {
          const value = row[column];
          return typeof value === 'bigint' ? Number(value) : value;
        });
        await client.query(sql, values);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    imported += rows.length;
    console.log('imported', table, rows.length);
  }

  const identities = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           pg_get_serial_sequence(c.oid::regclass::text, a.attname) AS seq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = current_schema()
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attidentity IN ('a', 'd')
    ORDER BY 1, 2
  `);
  for (const row of identities.rows) {
    if (!row.seq) continue;
    await client.query(
      `SELECT setval($1::regclass, COALESCE((SELECT MAX(${quote(row.column_name)}) FROM ${quote(row.table_name)}), 0) + 1, false)`,
      [row.seq],
    );
  }
  console.log('import-done', {tables: tables.length, rows: imported, identities: identities.rowCount});
} finally {
  client.release();
  await pool.end();
  sqlite.close();
}
