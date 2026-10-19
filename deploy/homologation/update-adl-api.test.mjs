import {test} from 'node:test';import assert from 'node:assert/strict';
import {productionSource} from './update-adl-api.mjs';
test('only committed production source; no synthetic access/data, tests, env or dependencies',()=>{
 for(const p of ['apps/api/src/index.ts','apps/web/src/App.tsx','packages/feed-store/src/platform.ts','package-lock.json','scripts/bootstrap-platform.ts'])assert(productionSource(p),p);
 for(const p of ['.env','.runtime/control.sqlite','scripts/synthetic-demo.ts','scripts/restart-synthetic-demo.mjs','apps/api/src/synthetic-demo.test.ts','apps/web/.env.production','apps/web/node_modules/a.js','apps/web/dist/index.html','docs/password.txt','backups/x.sqlite','scripts/validate-channel-layouts.mts'])assert(!productionSource(p),p);
});
