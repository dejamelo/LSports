// Isolated subprocess harness: real lifecycle, publisher, checkpoint and SQLite;
// no supplier calls, credentials, demo fallback, or repository runtime files.
import { setTimeout as delay } from 'node:timers/promises';
import { runConnected } from '../connected.js';
import { shutdownSignal } from '../shutdown.js';
const shutdown = shutdownSignal();
await runConnected(shutdown.signal, {
  path: process.argv[2], ticketPath: process.argv[3],
  config: {packages: [{lane:'prematch',packageId:4511,username:'isolated-test',password:'',hostname:'localhost',port:5672,tls:false,vhost:'test',queue:'test'}], snapshotUrl:'http://localhost',customersUrl:'http://localhost',recoveryMs:300000,staleMs:90000},
  session: async (_pkg, _config, state, save, signal) => {
    state.apply('prematch', [{fixtureId:777,outright:{competitionId:9,fixture:{fixtureName:'ISOLATED TEST',sport:{name:'Horse Racing'},status:1,participants:[{id:1,name:'Test runner'}]}}}], Date.now());
    state.set('prematch',{phase:'connected'});
    await save();
    console.log('READY');
    if (!signal.aborted) await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
    // Persistence must finish even after repeated signals during drain.
    await delay(150);
    state.apply('prematch', [{fixtureId:777,outright:{competitionId:9,fixture:{fixtureName:'ISOLATED TEST DRAINED',sport:{name:'Horse Racing'},status:1}}}], Date.now());
    await save();
  },
}).finally(()=>shutdown.dispose());
