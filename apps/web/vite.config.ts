import {defineConfig,loadEnv} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({mode})=>{const env=loadEnv(mode,'../..','');const ancestors=env.FRAME_ANCESTORS||'http://localhost:5173 http://127.0.0.1:5173';return {plugins:[react()],server:{port:5173,strictPort:true,headers:{'Content-Security-Policy':`frame-ancestors 'self' ${ancestors}`},proxy:{'/api':`http://127.0.0.1:${env.PORT||3001}`}},preview:{port:4173,headers:{'Content-Security-Policy':`frame-ancestors 'self' ${ancestors}`},proxy:{'/api':`http://127.0.0.1:${env.PORT||3001}`}}}});
