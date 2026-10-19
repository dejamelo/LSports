import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TicketStore} from '@lsports/feed-store/tickets';
import {demoSource} from '@lsports/demo';
import {createApp} from './app.js';
test('HTTP admission is persistent and idempotent; receipt escapes names; history and corrections are local only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adl-http-ticket-'));const store=new TicketStore(join(dir,'tickets.sqlite'));
 const feed=await demoSource.getEvents();const event=feed.events[0];event.home='<script>secret-name</script>';
 const source={getEvents:async()=>feed};const app=createApp(source,{ticketStore:store});const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api`;
 try{
  const body={stakeMinor:10000,selections:[{eventId:event.id,marketId:event.markets?.[0]?.id||'demo',selectionId:event.selections[0].id,expectedOdds:event.selections[0].odds}]};
  const send=()=>fetch(`${base}/tickets`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'http-test-0001'},body:JSON.stringify(body)});
  const results=await Promise.all([send(),send()]);assert(results.every(r=>r.status===201));const tickets=await Promise.all(results.map(r=>r.json()));assert.equal(tickets[0].id,tickets[1].id);
  assert.equal((await(await fetch(`${base}/tickets`)).json()).total,1);
  const html=await(await fetch(`${base}/tickets/${tickets[0].id}/receipt`)).text();assert.match(html,/&lt;script&gt;secret-name/);assert(!html.includes('<script>secret-name'));assert.match(html,/SIMULACIÓN/);assert.match(html,/Retorno potencial al aceptar:/);assert.match(html,/size:80mm auto/);const reprint=await(await fetch(`${base}/tickets/${tickets[0].id}/receipt`)).text();assert.equal(reprint,html);assert.equal((await(await fetch(`${base}/tickets`)).json()).total,1);
  feed.ticketOutcomes=[{eventId:event.id,marketId:body.selections[0].marketId,selectionId:event.selections[0].id,settlement:2,updatedAt:new Date().toISOString()}];
  let saved=await(await fetch(`${base}/tickets/${tickets[0].id}`)).json();assert.equal(saved.status,'WON');assert.equal(saved.revision,1);
  saved=await(await fetch(`${base}/tickets/${tickets[0].id}`)).json();assert.equal(saved.revision,1);
  assert.equal((await fetch(`${base}/posnet/test/capabilities`)).status,200);
  assert.equal((await fetch(`${base}/tickets?offset=-1`)).status,400);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
