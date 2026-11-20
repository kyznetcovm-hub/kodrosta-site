// Production-раздача статики без Cloudflare-специфики и без preview-подмен.
import {readFile, stat} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(file) {
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream';
}

// Возвращает относительные кандидаты внутри public-production.
// Никакие .., обратные слэши и нулевые байты не проходят.
export function assetCandidates(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return [];
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return [];
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return [];
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return [];
  const relative = parts.join('/');
  if (!relative) return ['index.html'];
  const candidates = [relative];
  if (!extname(relative)) {
    candidates.push(relative + '.html');
    candidates.push(relative + '/index.html');
  }
  return candidates;
}

// Убирает только Cloudflare-маяк. Яндекс.Метрику и остальные скрипты не трогает.
export function sanitizeHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*(?:cloudflareinsights|cdn-cgi\/challenge-platform)[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?cloudflareinsights[\s\S]*?<\/noscript>/gi, '');
}

export async function serveStatic(request, root) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {status: 405, headers: {allow: 'GET, HEAD'}});
  }
  const base = resolve(root);
  const url = new URL(request.url);
  for (const relative of assetCandidates(url.pathname)) {
    const file = resolve(base, relative);
    if (!file.startsWith(base + sep)) continue;
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const type = contentTypeFor(file);
    let body = await readFile(file);
    if (type.startsWith('text/html')) body = Buffer.from(sanitizeHtml(body.toString('utf8')), 'utf8');
    const headers = {
      'content-type': type,
      'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300',
    };
    return new Response(request.method === 'HEAD' ? null : body, {headers});
  }
  try {
    const notFound = await readFile(resolve(base, '404.html'));
    return new Response(request.method === 'HEAD' ? null : notFound, {
      status: 404,
      headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
    });
  } catch {
    return new Response('Not found', {
      status: 404,
      headers: {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'},
    });
  }
}
