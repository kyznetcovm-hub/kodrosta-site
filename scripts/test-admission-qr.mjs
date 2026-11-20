import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function browserScript(path, name) {
  const sandbox={}; sandbox.window=sandbox; sandbox.self=sandbox; sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL(path, import.meta.url), 'utf8'), sandbox);
  return sandbox[name];
}
const qrcode=browserScript('../js/vendor/qrcode-1.4.4.min.js','qrcode');
const jsQR=browserScript('../js/vendor/jsqr-1.4.0.js','jsQR');
assert.equal(typeof qrcode,'function');
assert.equal(typeof jsQR,'function');
test('локальные QR-библиотеки: приглашение генерируется и читается без CDN',()=>{
 const url='https://codrosta.club/admission?view=ticket#t='+'1a'.repeat(32);
 const qr=qrcode(0,'M');qr.addData(url);qr.make();
 const count=qr.getModuleCount(),quiet=4,scale=5,size=(count+quiet*2)*scale;
 const pixels=new Uint8ClampedArray(size*size*4);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const row=Math.floor(y/scale)-quiet,col=Math.floor(x/scale)-quiet;
  const dark=row>=0&&row<count&&col>=0&&col<count&&qr.isDark(row,col),at=(y*size+x)*4;
  pixels[at]=pixels[at+1]=pixels[at+2]=dark?0:255;pixels[at+3]=255;
 }
 assert.equal(jsQR(pixels,size,size).data,url);
});
