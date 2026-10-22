// Synthetic WAL fixture only; the isolated child exits abruptly after FULL commits.
import {TradeState} from '/app/apps/worker/src/state.ts';
import {checkpoint,persistRegularCheckpoint} from '/app/apps/worker/src/persistence.ts';
import {createPublisher} from '/app/packages/feed-store/src/index.ts';
import {DatabaseSync} from 'node:sqlite';
if(process.env.ADL_OFFLINE_FIXTURE!=='1')throw Error('ISOLATED_FIXTURE_ONLY');
const {readdir}=await import('node:fs/promises');if((await readdir('/data')).length)throw Error('EMPTY_SYNTHETIC_DIRECTORY_REQUIRED');
const s=new TradeState(),at=Date.now()-1000,path='/data/trade-feed.json';
for(const lane of ['prematch','inplay'])for(let id=1;id<=20;id++)s.apply(lane,[{fixtureId:id,fixture:{status:1},markets:[{id:1,status:1,bets:[{id:'1',price:'2.1',status:1,isChanged:1}]}]}],at);
s.apply('prematch',[{fixtureId:100,outright:{competitionId:90},markets:[]}],at);
await persistRegularCheckpoint(path,s);await createPublisher(path)(s.projection(),{...checkpoint(s,false),regularExternal:true});
const dbs=[];
for(const lane of ['prematch','inplay']){
 const db=new DatabaseSync('/data/trade-feed.json.'+lane+'.inbox.sqlite');dbs.push(db);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,received INTEGER NOT NULL,content BLOB NOT NULL,properties TEXT NOT NULL,fields TEXT NOT NULL);CREATE TABLE recovery(id INTEGER PRIMARY KEY,safe_seconds INTEGER);');
 const add=db.prepare('INSERT INTO inbox(received,content,properties,fields) VALUES(?,?,?,?)');
 for(let id=1;id<=100;id++)add.run(Date.now(),Buffer.from(JSON.stringify({Header:{Type:3,MsgGuid:'proof-'+id,ServerTimestamp:Date.now()},Body:{Events:[{FixtureId:1+id%20,Markets:[{Id:1,Status:1,Bets:[{Id:'1',Status:1,Price:'2.8',IsChanged:1,...(id===100?{Settlement:1}:{})}]}]}]}})),JSON.stringify({headers:{MessageType:3}}),'{}');
}
console.log('WAL fixture committed; simulate abrupt process exit');process.kill(process.pid,'SIGKILL');
