// Сборка production-статики: без noindex, без Cloudflare-маяка, с robots/sitemap.
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {sanitizeHtml} from './production-static.mjs';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'public-production');
const excluded = ['src/', 'scripts/', 'migrations/', 'functions/', 'runtime-yandex/', 'node_modules/', 'public/', 'public-production/'];
const allowed = /\.(?:html|css|js|mjs|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|mp4|webm|pdf|xml|txt|webmanifest)$/i;

await rm(target, {recursive: true, force: true});
await mkdir(target, {recursive: true});
let files = 0;
let bytes = 0;
for (const name of execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean)) {
  if (name.split('/').some((part) => part.startsWith('.'))) continue;
  if (excluded.some((prefix) => name.startsWith(prefix))) continue;
  if (name === '_redirects') continue; // /itpark обрабатывается приложением
  if (!allowed.test(name)) continue;
  const source = resolve(root, name);
  const info = await stat(source);
  if (!info.isFile()) continue;
  const destination = resolve(target, name);
  await mkdir(dirname(destination), {recursive: true});
  if (name.endsWith('.html')) {
    const html = sanitizeHtml(await readFile(source, 'utf8'));
    await writeFile(destination, html);
    bytes += Buffer.byteLength(html);
  } else {
    await copyFile(source, destination);
    bytes += info.size;
  }
  files += 1;
}
console.log(JSON.stringify({target, files, bytes}));
