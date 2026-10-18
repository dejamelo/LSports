import {createConnection} from 'node:net';
import {sanitizedCause} from './recovery-diagnostics.js';
export async function probeRecoveryPort(port=Number(process.env.PORT||3001)) {
 if(!Number.isSafeInteger(port)||port<1||port>65535)return {state:'unknown' as const,reason:'invalid_port',cause:undefined};
 return new Promise<{state:'listening'|'closed'|'unknown';host:string;port:number;reason?:string;cause?:ReturnType<typeof sanitizedCause>}>(resolve=>{
  const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(1500);
  socket.once('connect',()=>{socket.destroy();resolve({state:'listening',host:'127.0.0.1',port});});
  socket.once('error',error=>resolve({state:(error as NodeJS.ErrnoException).code==='ECONNREFUSED'?'closed':'unknown',host:'127.0.0.1',port,cause:sanitizedCause(error)}));
  socket.once('timeout',()=>{socket.destroy();resolve({state:'unknown',host:'127.0.0.1',port,reason:'timeout'});});
 });
}
