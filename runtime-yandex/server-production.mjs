// Production-сервер сайта: тот же Worker, но без preview-заглушек и demo-маршрутов.
import http from 'node:http';
import {resolve} from 'node:path';
import worker from '../src/index.js';
import {createDatabase} from './postgres.mjs';
import {allowedOrigins, buildSslConfig, loadEnv} from './env-production.mjs';
import {serveStatic} from './production-static.mjs';
import {startScheduler} from './scheduler.mjs';

const ROOT = resolve(import.meta.dirname, '../public-production');
const MAX_BODY = 1024 * 1024;

const env = loadEnv(process.env);
const ssl = buildSslConfig(env);
env.DB = createDatabase(env.DATABASE_URL, {ssl});
env.ASSETS = {fetch: (request) => serveStatic(request, ROOT)};

const origins = allowedOrigins(env.PUBLIC_ORIGIN);
const pending = new Set();
const ctx = {
  waitUntil(promise) {
    const task = Promise.resolve(promise).catch((error) => {
      console.error('background-failed', error?.code || error?.name || 'Error');
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  },
};

const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      return cacheStore.get(key)?.clone();
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      cacheStore.set(key, response.clone());
      if (cacheStore.size > 100) cacheStore.delete(cacheStore.keys().next().value);
    },
  },
};

function json(value, status = 200) {
  return Response.json(value, {status, headers: {'cache-control': 'no-store'}});
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume();
      const error = new Error('request_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toWebRequest(req, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(',') : value);
  }
  return new Request(new URL(req.url, env.PUBLIC_ORIGIN), {
    method: req.method,
    headers,
    body: body && body.length ? body : undefined,
  });
}

function send(res, response, head = false) {
  const headers = {};
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') continue;
    headers[key] = value;
  }
  if (!headers['x-content-type-options']) headers['x-content-type-options'] = 'nosniff';
  if (!headers['referrer-policy']) headers['referrer-policy'] = 'strict-origin-when-cross-origin';
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (head) {
    res.end();
    response.body?.cancel?.().catch(() => {});
    return;
  }
  response
    .arrayBuffer()
    .then((buffer) => res.end(Buffer.from(buffer)))
    .catch((error) => {
      console.error('response-failed', error?.code || error?.name || 'Error');
      res.destroy();
    });
}

async function dispatch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/health/ready') {
    try {
      await env.DB.pool.query('SELECT 1');
      return json({ok: true, mode: 'production', database: 'postgresql', region: 'ru', revision: env.RELEASE_SHA});
    } catch {
      return json({ok: false, error: 'database_unavailable'}, 503);
    }
  }
  if (url.pathname === '/itpark' || url.pathname === '/itpark/') {
    const target = 'https://codrosta.club/?utm_source=itpark_rameev&utm_medium=qr&utm_campaign=club_residents&utm_content=hall1_screen_v1';
    return Response.redirect(target, 302);
  }
  return worker.fetch(request, env, ctx);
}

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) {
    res.writeHead(403, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end('{"error":"cross-origin request blocked"}');
    return;
  }
  try {
    const body = await readBody(req);
    const response = await dispatch(toWebRequest(req, body));
    send(res, response, req.method === 'HEAD');
  } catch (error) {
    if (error?.status === 413) {
      res.writeHead(413, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      res.end('{"error":"request_too_large"}');
      return;
    }
    console.error('request-failed', error?.code || error?.name || 'Error');
    if (!res.headersSent) res.writeHead(500, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end('{"error":"internal_error"}');
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('request-failed', error?.code || error?.name || 'Error');
    if (!res.headersSent) res.writeHead(500, {'content-type': 'application/json; charset=utf-8'});
    res.end('{"error":"internal_error"}');
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 20000;
server.keepAliveTimeout = 5000;

let scheduler;
server.listen(env.PORT, env.HOST, () => {
  console.log('production-ready', {port: env.PORT, host: env.HOST, revision: env.RELEASE_SHA});
  if (!env.DISABLE_SCHEDULER) {
    scheduler = startScheduler({scheduled: worker.scheduled.bind(worker), env, logger: console});
  }
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log('shutdown', signal);
  scheduler?.stop();
  server.close();
  await Promise.race([Promise.all([...pending]).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  try {
    await env.DB.pool.end();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('unhandled-rejection', error?.code || error?.name || 'Error');
});
process.on('uncaughtException', (error) => {
  console.error('uncaught-exception', error?.code || error?.name || 'Error');
  process.exit(1);
});
