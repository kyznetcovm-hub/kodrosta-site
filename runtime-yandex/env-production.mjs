// Production-окружение: только реальные значения, без preview-заглушек.
import {readFileSync} from 'node:fs';

export const REQUIRED = [
  'DATABASE_URL',
  'BOT_TOKEN',
  'CHAT_ID',
  'ADMIN_USERNAMES',
  'ADMISSION_EVENT_ID',
  'ADMISSION_OWNER_USERNAME',
  'ADMISSION_SHEET_ID',
  'RESIDENTS_CHAT_ID',
];

export const OPTIONAL = [
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_SHEET_ID',
  'METRIKA_TOKEN',
  'METRIKA_REPORT_KEY',
  'EXPORT_KEY',
  'SUBSCRIPTION_ALERT_USERNAME',
  'ZADACHNIK_CRON_URL',
  'COOLING_WARN_DAYS',
  'COOLING_CRITICAL_DAYS',
  'METRIKA_COUNTER_ID',
  'PUBLIC_ORIGIN',
  'PG_CA_PATH',
  'PGSSL',
  'PORT',
  'HOST',
  'RELEASE_SHA',
  'DISABLE_SCHEDULER',
  'ADMISSION_SOURCE_LABEL',
];

const trim = (value) => String(value ?? '').trim();

export function loadEnv(source = process.env) {
  const missing = REQUIRED.filter((name) => !trim(source[name]));
  if (missing.length) {
    const error = new Error('Missing required environment variables: ' + missing.join(', '));
    error.code = 'ENV_MISSING';
    error.missing = missing;
    throw error;
  }

  const googleJson = trim(source.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (googleJson) {
    try {
      const parsed = JSON.parse(googleJson);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    } catch {
      const error = new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
      error.code = 'ENV_INVALID';
      throw error;
    }
  }

  const eventId = trim(source.ADMISSION_EVENT_ID);
  if (eventId.endsWith('-demo')) {
    const error = new Error('ADMISSION_EVENT_ID must be production, not a demo event');
    error.code = 'ENV_INVALID';
    throw error;
  }

  const publicOrigin = trim(source.PUBLIC_ORIGIN || 'https://codrosta.club').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicOrigin)) {
    const error = new Error('PUBLIC_ORIGIN must start with http:// or https://');
    error.code = 'ENV_INVALID';
    throw error;
  }

  const residentsChatId = trim(source.RESIDENTS_CHAT_ID);
  if (!Number.isFinite(Number(residentsChatId))) {
    const error = new Error('RESIDENTS_CHAT_ID must be numeric');
    error.code = 'ENV_INVALID';
    throw error;
  }

  return {
    DATABASE_URL: trim(source.DATABASE_URL),
    BOT_TOKEN: trim(source.BOT_TOKEN),
    CHAT_ID: trim(source.CHAT_ID),
    ADMIN_USERNAMES: trim(source.ADMIN_USERNAMES),
    ADMISSION_EVENT_ID: eventId,
    ADMISSION_OWNER_USERNAME: trim(source.ADMISSION_OWNER_USERNAME),
    ADMISSION_SHEET_ID: trim(source.ADMISSION_SHEET_ID),
    GOOGLE_SERVICE_ACCOUNT_JSON: googleJson,
    GOOGLE_SHEET_ID: trim(source.GOOGLE_SHEET_ID),
    METRIKA_TOKEN: trim(source.METRIKA_TOKEN),
    METRIKA_REPORT_KEY: trim(source.METRIKA_REPORT_KEY),
    EXPORT_KEY: trim(source.EXPORT_KEY),
    RESIDENTS_CHAT_ID: residentsChatId,
    SUBSCRIPTION_ALERT_USERNAME: trim(source.SUBSCRIPTION_ALERT_USERNAME),
    ZADACHNIK_CRON_URL: trim(source.ZADACHNIK_CRON_URL),
    COOLING_WARN_DAYS: trim(source.COOLING_WARN_DAYS),
    COOLING_CRITICAL_DAYS: trim(source.COOLING_CRITICAL_DAYS),
    METRIKA_COUNTER_ID: trim(source.METRIKA_COUNTER_ID),
    PUBLIC_ORIGIN: publicOrigin,
    PG_CA_PATH: trim(source.PG_CA_PATH),
    PGSSL: trim(source.PGSSL),
    PORT: Number(source.PORT || 8080),
    HOST: trim(source.HOST || '0.0.0.0'),
    RELEASE_SHA: trim(source.RELEASE_SHA || 'dev'),
    DISABLE_SCHEDULER: trim(source.DISABLE_SCHEDULER) === '1' || trim(source.DISABLE_SCHEDULER).toLowerCase() === 'true',
    ADMISSION_SOURCE_LABEL: trim(source.ADMISSION_SOURCE_LABEL),
  };
}

// Managed PostgreSQL требует TLS. CA обязателен, кроме явного PGSSL=require.
export function buildSslConfig(env) {
  if (env.PG_CA_PATH) {
    return {ca: readFileSync(env.PG_CA_PATH, 'utf8'), rejectUnauthorized: true};
  }
  if (env.PGSSL === 'require') {
    return {rejectUnauthorized: false};
  }
  const error = new Error('Set PG_CA_PATH (Yandex CA) or PGSSL=require for PostgreSQL TLS');
  error.code = 'ENV_INVALID';
  throw error;
}

export function allowedOrigins(publicOrigin) {
  const origin = String(publicOrigin || '').replace(/\/+$/, '');
  const set = new Set([origin]);
  if (origin.startsWith('https://') && !origin.startsWith('https://www.')) {
    set.add('https://www.' + origin.slice('https://'.length));
  }
  return set;
}
