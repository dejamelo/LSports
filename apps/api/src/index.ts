import { createApp } from './app.js';
if(process.env.DATA_MODE && process.env.DATA_MODE!=='demo') throw new Error('Only demo mode is implemented. Real TRADE integration requires a separate adapter.');
const port=Number(process.env.PORT||3001);
const server=createApp().listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Demo API listening on ${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>server.close(()=>process.exit(0)));
