const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const root=require('path').resolve(__dirname, '..')+'/';
const source=fs.readFileSync(root+'js/campaign-analytics.js','utf8');
const storage=new Map();
function page(search='', blocked=false){
 const calls=[],listeners={};
 const ctx={URL,URLSearchParams,location:{search,href:'https://codrosta.club/'+search},sessionStorage:{getItem:k=>{if(blocked)throw Error();return storage.get(k)},setItem:(k,v)=>{if(blocked)throw Error();storage.set(k,v)}},document:{addEventListener:(k,v)=>listeners[k]=v},window:{ym:(...a)=>calls.push(a)}};
 vm.runInNewContext(source,ctx);return {ctx,calls,listeners};
}
let p=page('?utm_source=itpark_rameev&utm_medium=qr&utm_campaign=club_residents&utm_content=hall1_screen_v1');
assert.equal(p.calls.length,1);assert.equal(p.calls[0][2],'qr_landing_open');
p=page();assert.equal(p.calls.length,0);assert.equal(p.ctx.window.kodrostaAnalytics.attribution().utm_source,'itpark_rameev');
p.listeners.click({target:{closest:()=>({href:'https://t.me/codrosta'})}});assert.equal(p.calls.length,0);
p.listeners.click({target:{closest:()=>({href:'https://t.me/Kodrosta'})}});assert.equal(p.calls[0][2],'manager_telegram_click');
p=page('?utm_source=newsletter&utm_medium=email');assert.equal(p.calls.length,0);assert.equal(p.ctx.window.kodrostaAnalytics.attribution().utm_campaign,undefined);
p=page('?utm_source=itpark_rameev&utm_medium=qr',true);assert.equal(p.calls.length,1);
p.ctx.window.ym=undefined;p.ctx.window.kodrostaAnalytics.track('apply_form_open');
console.log('PASS: QR only, internal navigation, new campaign, Telegram destination, blocked storage/counter');

// Проверка настоящего обработчика форм: только сеть заменена заглушкой.
const main=fs.readFileSync(root+'js/main.js','utf8');
const formCode=main.slice(main.indexOf('  document.querySelectorAll(".js-form").forEach'),main.indexOf('  // ---- Живой текст'));
async function submit(type, outcome){
 let handler; const goals=[]; let payload;
 const form={addEventListener:(name,fn)=>handler=fn,getAttribute:()=>type,querySelector:()=>({value:'test',disabled:false}),reset:()=>{}};
 const ctx={document:{querySelectorAll:()=>[form]},validate:()=>null,showStatus:()=>{},localStorage:{getItem:()=>'',setItem:()=>{}},window:{kodrostaAnalytics:{attribution:()=>({utm_source:'itpark_rameev',utm_medium:'qr'}),track:g=>goals.push(g)}},ym:(id,method,g)=>goals.push(g),MANAGER_TELEGRAM:'https://t.me/Kodrosta',fetch:async (url,opts)=>{payload=JSON.parse(opts.body); if(outcome==='network')throw Error(); return {ok:true,json:async()=>({ok:outcome==='ok'})}}};
 vm.runInNewContext(formCode,ctx);handler({preventDefault(){}});await new Promise(r=>setImmediate(r));
 assert.equal(payload.utm_source,'itpark_rameev');
 assert.equal(goals.includes(type==='apply'?'apply_form_success':'event_form_success'),outcome==='ok');
}
(async()=>{
 for(const type of ['apply','event'])for(const outcome of ['ok','error','network'])await submit(type,outcome);
 console.log('PASS: both forms, API success/error/network failure, UTM payload');
 let worker=fs.readFileSync(root+'src/index.js','utf8').replace(/^import .*;$/gm,'').replace('export default {','const worker = {');
 let sent,record;
 const ctx={URL,Response,Request,console,recordFormTouch:async(env,x)=>record=x,fetch:async(url,opts)=>{sent=JSON.parse(opts.body);return {ok:true}}};
 vm.createContext(ctx);vm.runInContext(worker,ctx);
 for(const type of ['apply','event']){
  const request=new Request('https://codrosta.club/api/submit',{method:'POST',body:JSON.stringify({type,name:'Test',phone:'000',telegram:'test',utm_source:'itpark_rameev',utm_medium:'qr',utm_content:'hall1_screen_v1'})});
  const result=await ctx.handleSubmit(request,{BOT_TOKEN:'mock',CHAT_ID:'mock'});
  assert.equal(result.status,200);assert.ok(sent.text.includes('utm_source=itpark_rameev'));assert.ok(record.note.includes('utm_content=hall1_screen_v1'));
 }
 console.log('PASS: backend attribution in manager message and record (network mocked, no messages sent)');
 const htmlFiles=['index.html','blog.html','privacy.html',...fs.readdirSync(root+'blog').map(x=>'blog/'+x)];
 for(const file of htmlFiles)assert.equal(fs.readFileSync(root+file,'utf8').split('src="/js/campaign-analytics.js"').length,2);
 console.log('PASS: analytics included once on all '+htmlFiles.length+' pages');
})().catch(e=>{console.error(e);process.exitCode=1});
