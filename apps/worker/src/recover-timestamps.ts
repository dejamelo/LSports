import {createConnection} from 'node:net';
import {statePath} from '@lsports/feed-store';
import {ticketDatabasePath} from '@lsports/feed-store/tickets';
import {planTimestampRecovery,applyTimestampRecovery} from './timestamp-recovery.js';
const args=process.argv.slice(2);
const value=(name:string)=>args[args.indexOf(name)+1];
const mode=args.includes('--settlements')?'settlements':'quotes';
const fixture=Number(value('--fixture')),market=Number(value('--market'));
async function main(){
 if(!args.includes('--fixture')||!args.includes('--market')||!Number.isSafeInteger(fixture)||fixture<=0||!Number.isSafeInteger(market)||market<=0)throw new Error('Usage: --fixture ID --market ID [--apply]');
 if(args.includes('--apply')){
  const open=await new Promise<boolean>(resolve=>{const socket=createConnection({host:'127.0.0.1',port:Number(process.env.PORT||3001)});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
  if(open)throw new Error('Stop API and worker before --apply');
  console.log(JSON.stringify(await applyTimestampRecovery(statePath(),ticketDatabasePath(),fixture,market,Date.now(),mode),null,2));
 }else console.log(JSON.stringify({dryRun:true,...await planTimestampRecovery(statePath(),fixture,market,Date.now(),mode)},null,2));
}
void main().catch(()=>{console.error('Timestamp recovery aborted. Stop API/worker; inspect the dry-run and backups. No credentials or raw exceptions printed.');process.exitCode=1;});
