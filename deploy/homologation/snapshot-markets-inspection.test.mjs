import{test}from'node:test';import assert from'node:assert/strict';
import{marketsShapeRejection as inspect}from'./snapshot-markets-inspection.mjs';
import{TransformerUtil,GetEventsResultElement}from'trade360-nodejs-sdk';
test('all branches of the aggregate rejection are separated without values or arbitrary keys',()=>{
 for(const [Markets,path,type] of [[null,'Markets','null'],[{},'Markets','object'],['PRIVATE','Markets','string'],[[null],'Markets[0]','null'],[[[]],'Markets[0]','array'],[[{Bets:null}],'Markets[0].Bets','null'],[[{Bets:{PRIVATE:'secret'}}],'Markets[0].Bets','object']]){
  const r=inspect({FixtureId:123,Markets});assert.equal(r.path,path);assert.equal(r.actualType,type);assert.equal(r.fixtureId,123);assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!JSON.stringify(r).includes('secret'));
 }
 for(const r of [{FixtureId:1},{FixtureId:1,Markets:[]},{FixtureId:1,Markets:[{Id:1},{Id:2,Bets:[]}]}])assert.equal(inspect(r),null);
});
test('SDK comparison distinguishes runtime null preservation from declared optional arrays',()=>{
 const row=TransformerUtil.transform({FixtureId:123,Fixture:{Status:1},Markets:null},GetEventsResultElement);assert.equal(row.markets,null);
 const market=TransformerUtil.transform({FixtureId:123,Fixture:{Status:1},Markets:[{Id:1,Bets:null}]},GetEventsResultElement);assert.equal(market.markets[0].bets,null);
 // SDK conversion alone is NOT evidence that these shapes occurred in AWS or
 // permission to expand the declared Market[] / Bet[] contract.
 assert.equal(inspect({Markets:null}).actualType,'null');assert.equal(inspect({Markets:[{Bets:null}]}).actualType,'null');
});
