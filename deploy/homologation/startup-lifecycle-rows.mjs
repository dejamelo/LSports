export function startupLifecycleRows(rows){
 const lifecycle=rows.filter(r=>r.stage==='recent_lifecycle');
 const tail=new Set(lifecycle.slice(-8));
 return lifecycle.filter(r=>tail.has(r)||['inbox.actor_failure','inbox.actor_lifecycle','worker.start'].includes(r.record?.operation));
}
