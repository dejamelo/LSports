import express from 'express';
import { demoSource } from '@lsports/demo';
export function createApp() {
 const app=express();
 app.disable('x-powered-by');
 app.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next()});
 app.get('/api/health',(_req,res)=>res.json({status:'ok',mode:'demo'}));
 app.get('/api/events',async(_req,res)=>res.json(await demoSource.getEvents()));
 app.use('/api',(_req,res)=>res.status(404).json({error:'Ruta no encontrada'}));
 return app;
}
