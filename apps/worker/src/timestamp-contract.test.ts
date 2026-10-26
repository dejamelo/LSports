import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { root } from "@lsports/feed-store";
import { providerTimestamp } from "./timestamp-contract.js";
test("contract UTC preserves 100ns ordering across zones, SDK, snapshot, checkpoint and invalid calendar dates", () => {
  const outputs = [];
  for (const zone of ["UTC", "America/Sao_Paulo", "Europe/Berlin"]) {
    const script = `
 import assert from 'node:assert/strict';
 import {decodeMessage} from './apps/worker/src/messages.ts';
 import {TradeState,preciseBetOrder} from './apps/worker/src/state.ts';
 import {providerTimestamp} from './apps/worker/src/timestamp-contract.ts';
 import {checkpoint,restore} from './apps/worker/src/persistence.ts';
 import {createPublisher} from '@lsports/feed-store';
 import {mkdtemp,rm} from 'node:fs/promises';
 const plain='2026-10-18T14:39:04.0173136',z=plain+'Z';
 assert.equal(providerTimestamp(plain).order,providerTimestamp(z).order);
 assert.equal(providerTimestamp('2026-10-18T11:39:04.0173136-03:00').order,providerTimestamp(z).order);
 const state=new TradeState();const at=Date.parse('2026-10-18T14:40:00Z');
 state.apply('prematch',[{fixtureId:900283,outright:{competitionId:900111,fixture:{sport:{name:'Horse Racing'},status:1,participants:[{id:1,name:'TEST'}]}}}],at-1000);
 const receive=(last,price,settlement)=>{const d=decodeMessage(Buffer.from(JSON.stringify({Header:{Type:settlement===undefined?41:42,MsgGuid:'test-'+last,CreationDate:'2026-10-18T14:40:00'},Body:{Competition:{Id:900111,Events:[{FixtureId:900283,Markets:[{Id:160,Status:settlement===undefined?1:3,Bets:[{Id:'1',Status:1,Price:price,Settlement:settlement,LastUpdate:last}]}]}]}}})));state.apply('prematch',d.events,d.at);};
 receive(plain,'2.10');receive('2026-10-18T14:39:04.0173137Z','2.20');receive('2026-10-18T14:39:04.0173135','9.99');
 const row=state.rows.prematch.get('outright:900111:900283');assert.equal(row.markets.get('160').bets[0].price,'2.20');assert.equal(row.marketReceipt.staleBetUpdates,1);
 receive('2026-10-18T14:39:04.0173138',undefined,2);receive('2026-10-18T14:39:04.0173136Z','9.99');assert.equal(row.markets.get('160').bets[0].settlement,2);
 const directory=await mkdtemp('/tmp/adl-utc-proof-');try{await createPublisher(directory+'/feed.json')(state.feed(),checkpoint(state));const restored=new TradeState();await restore(restored,directory+'/feed.json');assert.equal(preciseBetOrder(restored.rows.prematch.get('outright:900111:900283'),'160:1',restored.rows.prematch.get('outright:900111:900283').markets.get('160').bets[0]),preciseBetOrder(row,'160:1',row.markets.get('160').bets[0]));assert(!restored.feed().events[0].selections[0].available);}finally{await rm(directory,{recursive:true,force:true});}
 console.log(JSON.stringify({utc:providerTimestamp(plain).milliseconds,order:providerTimestamp(plain).order,price:row.markets.get('160').bets[0].price,settlement:row.markets.get('160').bets[0].settlement}));`;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: root, env: { ...process.env, TZ: zone }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    outputs.push(JSON.parse(result.stdout));
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[1], outputs[2]);
  for (const invalid of [
    "2026-02-30T14:39:04",
    "2026-13-01T00:00:00Z",
    "2026-10-18T24:00:00",
    "2026-10-18T14:60:00",
    "2026-10-18T14:39:04+25:00",
    "private-value",
  ])
    assert.equal(providerTimestamp(invalid), undefined);
});
