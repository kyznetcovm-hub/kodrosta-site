import {execFileSync} from 'node:child_process';
import {readFile,copyFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
const root = resolve(import.meta.dirname,'..'), target=resolve(root,'public');
await rm(target,{recursive:true,force:true}); await mkdir(target,{recursive:true});
const excluded = ['src/','scripts/','migrations/','functions/','runtime-yandex/','node_modules/'];
let count=0;
for (const name of execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)) {
  if (name.split('/').some(part=>part.startsWith('.')) || excluded.some(prefix=>name.startsWith(prefix))) continue;
  if (!/\.(?:html|css|js|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|mp4|webm|pdf)$/i.test(name) && !['_redirects','robots.txt'].includes(name)) continue;
  const destination=resolve(target,name); await mkdir(dirname(destination),{recursive:true});
  await copyFile(resolve(root,name),destination); count++;
}
await writeFile(resolve(target,'robots.txt'),'User-agent: *\nDisallow: /\n');
console.log(JSON.stringify({staticFiles:count}));
