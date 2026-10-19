// Classify only fixed socket/descriptor/log categories; never print raw lsof or log text.
export function socketSummary(text:string){
 const sockets:{portClass:string;state:string}[]=[];let name='';
 for(const line of text.split('\n')){
  if(line.startsWith('f'))name='';
  if(line.startsWith('n'))name=line.slice(1);
  if(line.startsWith('TST=')){
   const raw=line.slice(4);const state=['ESTABLISHED','CLOSE_WAIT','CLOSED','FIN_WAIT_1','FIN_WAIT_2','LAST_ACK','LISTEN','SYN_SENT','TIME_WAIT'].includes(raw)?raw:'OTHER';
   const remote=name.match(/->.*:(\d+)$/)?.[1];
   sockets.push({portClass:remote==='5672'||remote==='5671'?'amqp':remote==='443'?'https':remote?'other_remote':'local_or_listen',state});
  }
 }
 return sockets;
}
export function descriptorSummary(text:string){
 const result:{fd:number;kind:string;path?:string}[]=[];let record:{fd:number;kind:string;path?:string}|undefined;
 for(const line of text.split('\n')){
  if(line.startsWith('f')){
   const fd=Number(line.slice(1));record=[1,2].includes(fd)?{fd,kind:'unknown'}:undefined;if(record)result.push(record);
  }else if(line.startsWith('t')&&record){
   record.kind=({REG:'regular_file',CHR:'terminal_or_character_device',FIFO:'pipe',PIPE:'pipe',IPv4:'socket',IPv6:'socket',unix:'socket'} as Record<string,string>)[line.slice(1)]||'other';
  }else if(line.startsWith('n')&&record)record.path=line.slice(1);
 }
 return result;
}
export function shutdownLogSignals(text:string){
 let stopping=0,complete=0,error=0;
 for(const line of text.split('\n')){
  try{const item=JSON.parse(line);if(item.operation!=='worker.shutdown')continue;
   if(item.status==='stopping')stopping++;
   if(item.status==='ok'&&item.lock==='released')complete++;
   if(item.status==='error')error++;
  }catch{}
 }
 return {stopping,complete,error,scope:'bounded_shared_log_not_proven_pid_or_current_signal'};
}
