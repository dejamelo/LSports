// Read-only query-plan inspection: never executes the backlog aggregate or creates an index.
import{DatabaseSync}from'node:sqlite';import{statSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';
const path=process.argv[1];if(!/^\/app\/\.runtime\/feed\/trade-feed\.json\.(prematch|inplay)\.inbox\.sqlite$/.test(path))throw Error('INBOX_PATH_UNVERIFIED');
const db=new DatabaseSync(path,{readOnly:true});try{
 const query='SELECT count(*) AS processingBacklog,min(received) AS oldest FROM inbox WHERE id>?';
 console.log(JSON.stringify({lane:path.includes('.prematch.')?'prematch':'inplay',plan:db.prepare('EXPLAIN QUERY PLAN '+query).all(8192).map(r=>String(r.detail)),databaseBytes:statSync(path).size,walBytes:(()=>{try{return statSync(path+'-wal').size;}catch{return 0;}})(),queryExecuted:false,indexCreated:false,installedIngressSourceSha256:createHash('sha256').update(readFileSync('/app/apps/worker/src/durable-ingress.mjs')).digest('hex')}));
}finally{db.close();}
