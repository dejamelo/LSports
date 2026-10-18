import {inspectRecovery} from "./inspect-recovery.js";
import {RecoveryAbort,emptyWrites,reportRecoveryError} from "./recovery-diagnostics.js";
import {probeRecoveryPort} from './recovery-preflight.js';
import {statePath} from '@lsports/feed-store';
import {ticketDatabasePath} from '@lsports/feed-store/tickets';
import {planTimestampRecovery,applyTimestampRecovery} from './timestamp-recovery.js';
const args=process.argv.slice(2);
const value=(name:string)=>args[args.indexOf(name)+1];
const mode=args.includes('--settlements')?'settlements':'quotes';
const fixture=Number(value('--fixture')),market=Number(value('--market'));
async function main(){
 if(args.includes('--inspect')){console.log(JSON.stringify({...await inspectRecovery(statePath(),ticketDatabasePath()),apiPort:await probeRecoveryPort()},null,2));return;}
 if(!args.includes('--fixture')||!args.includes('--market')||!Number.isSafeInteger(fixture)||fixture<=0||!Number.isSafeInteger(market)||market<=0)throw new RecoveryAbort({status:'aborted',stage:'cli.arguments',reason:'Usage: --inspect OR --fixture ID --market ID [--settlements] [--apply]',writes:emptyWrites()});
 if(args.includes('--apply')){
  const port=await probeRecoveryPort();
  if(port.state!=='closed')throw new RecoveryAbort({status:'aborted',stage:'api.port_check',reason:port.state==='listening'?'API port is listening; no apply was attempted':'API port could not be verified; no apply was attempted',writes:emptyWrites(),...(port.cause?{cause:port.cause}:{})});
  console.log(JSON.stringify(await applyTimestampRecovery(statePath(),ticketDatabasePath(),fixture,market,Date.now(),mode),null,2));
 }else console.log(JSON.stringify({dryRun:true,...await planTimestampRecovery(statePath(),fixture,market,Date.now(),mode)},null,2));
}
void main().catch(error=>{console.error(JSON.stringify(reportRecoveryError(error),null,2));process.exitCode=1;});
