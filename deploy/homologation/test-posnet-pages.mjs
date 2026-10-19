import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPage} from './validate-posnet-pages.mjs';

test('checks HTML and critical asset samples using GET without credentials',async()=>{
 const seen=[];
 const result=await inspectPage('https://www.loteriaargentina.lat/',async(url,opts)=>{
  seen.push(opts);assert.equal(opts.method,'GET');assert.equal(opts.credentials,'omit');
  if(url.pathname.endsWith('.js'))return new Response('export{}',{headers:{'content-type':'text/javascript'}});
  if(url.pathname.endsWith('.css'))return new Response('body{}',{headers:{'content-type':'text/css'}});
  return new Response('<html><script src="/app.js"></script><link href="/app.css"></html>',{headers:{'content-type':'text/html'}});
 });
 assert.equal(result.status,'ok');assert.equal(result.assets.length,2);assert.equal(seen.length,3);
 assert.equal(result.sso,'not_authenticated_by_this_check');
});
test('does not follow external SSO redirects or expose token query',async()=>{
 let calls=0;
 const result=await inspectPage('https://demo.loteriaargentina.lat/',async()=>{
  calls++;return new Response('',{status:302,headers:{location:'https://sso.example/auth?token=PRIVATE_VALUE'}});
 });
 assert.equal(calls,1);assert.equal(result.status,'requires_manual_validation');
 assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
});
test('rejects HTML fallback served as JS with HTTP 200',async()=>{
 const result=await inspectPage('https://demo.loteriaargentina.lat/',async(url)=>new Response(url.pathname==='/'?'<html><script src="/app.js"></script></html>':'<html>fallback</html>',{headers:{'content-type':'text/html'}}));
 assert.equal(result.status,'failed');assert.equal(result.assets[0].ok,false);
});
test('sanitizes network error and preserves known TLS code',async()=>{
 const result=await inspectPage('https://demo.loteriaargentina.lat/',async()=>{throw Object.assign(new Error('PRIVATE_VALUE'),{cause:{code:'CERT_HAS_EXPIRED'}});});
 assert.equal(result.reason,'CERT_HAS_EXPIRED');assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
});
