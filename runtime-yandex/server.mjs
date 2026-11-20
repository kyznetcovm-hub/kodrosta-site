import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import worker from '../src/index.js';
import {createDatabase} from './postgres.mjs';
import {initialize} from './initialize.mjs';

if (process.env.PREVIEW_MODE !== '1') throw new Error('This entry point is restricted to isolated preview mode');
const ROOT=resolve(import.meta.dirname,'../public');
const ORIGIN=process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8080';
const sessions=new Map(), outbox=[];
const DB=createDatabase(process.env.DATABASE_URL);
const TOKEN=randomBytes(32).toString('hex');
const telegram = async (method,body) => {
  outbox.push({method,body,at:new Date().toISOString()}); if(outbox.length>500) outbox.shift();
  return {message_id:outbox.length};
};
// Тестовый процесс не имеет рабочих ключей и не может отправлять запросы наружу.
globalThis.fetch=async (input,options={}) => {
  const url=new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if(url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith('/bot'+TOKEN+'/')) throw new Error('External integration is disabled in preview');
  const body=JSON.parse(options.body || '{}');
  return Response.json({ok:true,result:await telegram(url.pathname.split('/').pop(),body)});
};
globalThis.caches={default:{async match(){},async put(){}}};
export const env={DB,BOT_TOKEN:TOKEN,CHAT_ID:'-1',ADMIN_USERNAMES:'demo_admin',ADMISSION_OWNER_USERNAME:'demo_admin',
  ADMISSION_EVENT_ID:'premiya-2026-yandex-demo',ADMISSION_DEMO_TELEGRAM:telegram};
await initialize(env);

const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.gif':'image/gif','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf',
  '.mp4':'video/mp4','.webm':'video/webm','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8'};
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'cache-control':'no-store',...headers}});
const banner=`<aside style="background:#001b7d;color:white;padding:10px 20px;text-align:center;font:500 16px/1.5 sans-serif;position:relative;z-index:10001">Тестовая версия в Яндексе. Только вымышленные данные. Реальные заявки не отправляются. <a style="color:#8af1ac" href="/preview">Проверить функции</a></aside>`;
function inject(html) {
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,script=> /mc\.yandex\.ru|cloudflareinsights|googletagmanager/.test(script)?'':script);
  html=html.replace(/<noscript>[\s\S]*?mc\.yandex\.ru[\s\S]*?<\/noscript>/gi,'');
  return html.replace(/<body([^>]*)>/i,'<body$1>'+banner).replaceAll('https://codrosta.club',ORIGIN);
}
async function assets(request) {
  let pathname;
  try {pathname=decodeURIComponent(new URL(request.url).pathname);} catch {return new Response('Bad path',{status:400});}
  if(pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part=>part.startsWith('.')&&part)) return new Response('Not found',{status:404});
  let file=resolve(ROOT,'.'+(pathname === '/'?'/index.html':pathname));
  if(!file.startsWith(ROOT+sep)) return new Response('Not found',{status:404});
  try {
    if(!extname(file)) file+='.html';
    if(!(await stat(file)).isFile()) return new Response('Not found',{status:404});
    let body=await readFile(file); const type=TYPES[extname(file)] || 'application/octet-stream';
    if(type.startsWith('text/html')) body=inject(body.toString());
    return new Response(body,{headers:{'content-type':type,'cache-control':type.startsWith('text/html')?'no-store':'public, max-age=300'}});
  } catch(error) {if(error.code==='ENOENT'||error.code==='ENOTDIR')return new Response('Not found',{status:404});throw error;}
}
env.ASSETS={fetch:assets};
function initData(role) {
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),
    user:JSON.stringify({id:role==='host'?826002:826001,username:role==='host'?'demo_host':'demo_admin',first_name:'Тестовый пользователь'})});
  const check=[...params.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  const secret=createHmac('sha256','WebAppData').update(TOKEN).digest();
  params.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return params.toString();
}
const HUB=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тест сайта в Яндексе</title>
<style>body{font:18px/1.6 system-ui;color:#001b7d;margin:40px auto;padding:0 24px;max-width:780px}a{color:#001b7d}li{margin:14px 0}code{background:#eee;padding:3px}h1{line-height:1.15}</style>
<h1>Код Роста — тест в Яндексе</h1><p>Изолированная версия сайта с PostgreSQL. Все участники и билеты здесь вымышленные. Отправка в Telegram и другие рабочие системы отключена.</p>
<ul><li><a href="/">Главная сайта</a></li><li><a href="/premiya">Страница премии</a></li><li><a href="/admission">Билеты: роли организатора и хостес</a></li><li><a href="/admission#t=${'1'.repeat(64)}">Тестовое приглашение</a></li><li><a href="/calendar.ics">Календарь мероприятий</a></li></ul>
<p>Для проверки формы: имя <code>ТЕСТ — Гость</code>, телефон <code>+70000000000</code>, Telegram <code>@demo_user</code>.</p></html>`;
export async function dispatch(request) {
  const url=new URL(request.url), path=url.pathname;
  if(path==='/health/ready') {await DB.pool.query('SELECT 1');return json({ok:true,mode:'preview',database:'postgresql',region:'ru',revision:process.env.RELEASE_SHA || 'local'});}
  if(path==='/preview') return new Response(HUB,{headers:{'content-type':'text/html; charset=utf-8'}});
  if(path==='/api/telegram-webhook')return json({error:'Webhook disabled in preview'},404);
  if(path==='/api/admission-demo/info')return json({demo:true});
  if(path==='/api/admission-demo/session'&&request.method==='POST') {
    let body;try{body=await request.json();}catch{return json({error:'Некорректный запрос'},400);}
    if(!['admin','host'].includes(body?.role))return json({error:'Некорректная роль'},400);
    for(const[key,value]of sessions)if(value.expires<Date.now())sessions.delete(key);
    if(sessions.size>=500)return json({error:'Слишком много тестовых сессий'},429);
    const key=randomBytes(24).toString('hex');sessions.set(key,{role:body.role,expires:Date.now()+3600000});
    return json({ok:true},200,{'set-cookie':`admission_demo=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${ORIGIN.startsWith('https:')?'; Secure':''}`});
  }
  if(path==='/api/admission-demo/logout'&&request.method==='POST')return json({ok:true},200,{'set-cookie':'admission_demo=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
  if(request.method==='POST'&&(path==='/api/submit'||path==='/api/admission/create')) {
    let body;try{body=await request.clone().json();}catch{return json({error:'bad_request'},400);}
    if(!/^тест/i.test(String(body.name||'')) || (path==='/api/submit' && (String(body.phone||'').replace(/\D/g,'')!=='70000000000'||String(body.telegram||'').replace(/^@/,'')!=='demo_user')))
      return json({ok:false,error:'В тестовой версии используй имя «ТЕСТ — Гость», телефон +70000000000 и Telegram @demo_user.'},422);
  }
  if(path.startsWith('/api/')) {
    const session=sessions.get((request.headers.get('cookie')||'').match(/(?:^|;\s*)admission_demo=([a-f0-9]+)/)?.[1]);
    if(session&&session.expires>Date.now()) {
      const headers=new Headers(request.headers);headers.set('authorization','tma '+initData(session.role));
      headers.delete('x-admission-key');request=new Request(request,{headers});
    }
  }
  const response=await worker.fetch(request,env,{waitUntil(promise){promise.catch(error=>console.error('background',error.code||error.name));}});
  return response;
}
export const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,ORIGIN);
    if(req.headers.origin&&req.headers.origin!==ORIGIN)return send(json({error:'Cross-origin request blocked'},403));
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>65536)return send(json({error:'Request too large'},413));chunks.push(chunk);}
    const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
    let response=await dispatch(new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}));
    if(/application\/json|text\/(?:html|calendar)/.test(response.headers.get('content-type')||'')) {
      const body=(await response.text()).replaceAll('https://codrosta.club',ORIGIN);
      response=new Response(body,{status:response.status,headers:response.headers});
    }
    await send(response);
    async function send(response) {
      const headers=Object.fromEntries(response.headers);delete headers['content-length'];
      Object.assign(headers,{'x-robots-tag':'noindex, nofollow, noarchive','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
      res.writeHead(response.status,headers);res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
    }
  }catch(error){console.error('request-failed',error.code||error.name,error.message?.slice(0,220));if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"Ошибка тестового сервера"}');}
});
if(process.env.NO_LISTEN!=='1')server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('preview-ready'));
process.on('SIGTERM',()=>server.close(()=>DB.pool.end().then(()=>process.exit(0))));
