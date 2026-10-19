// amqplib's close() promise needs CloseOk; a socket close can occur without it.
// Actual transport closure is sufficient for cleanup, AFTER the caller drains processing.
import type {EventEmitter} from 'node:events';
export function connectionCloser(connection:Pick<EventEmitter,'once'|'removeListener'>&{close:()=>Promise<void>}){
 let transportEnded=false;let closing:Promise<void>|undefined;
 connection.once('close',()=>{transportEnded=true;});
 return ()=>closing??=Promise.resolve().then(()=>{
  if(transportEnded)return;
  return new Promise<void>(resolve=>{
   let done=false;
   const finish=()=>{if(done)return;done=true;connection.removeListener('close',finish);resolve();};
   connection.once('close',finish);
   // Defer invocation: shared closing promise exists before synchronous events/re-entry.
   Promise.resolve().then(()=>connection.close()).then(finish,finish);
  });
 });
}
