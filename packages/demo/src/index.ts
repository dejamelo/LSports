import type { EventSource, SportEvent } from '@lsports/contracts';
const match = (id:string,sport:SportEvent['sport'],league:string,home:string,away:string,time:string,odds:number[],live=false,score?:string): SportEvent => ({id,sport,league,home,away,time,live,score,market:sport==='tenis'?'Ganador del partido':'Resultado del partido',selections:odds.map((value,i)=>({id:`${id}-${i}`,label:odds.length===3?['1','X','2'][i]:[home,away][i],odds:value}))});
export const demoEvents: SportEvent[] = [
match('river-boca','futbol','Argentina · Liga Profesional','River Plate','Boca Juniors','Hoy · 21:30',[2.15,3.20,3.45]),
match('racing-ind','futbol','Argentina · Liga Profesional','Racing Club','Independiente','Hoy · 19:15',[1.95,3.10,4.10]),
match('real-city','futbol','Europa · Champions League','Real Madrid','Manchester City',"67′ · 2.º tiempo",[2.40,2.85,3.05],true,'1 : 1'),
match('psg-inter','futbol','Europa · Champions League','Paris Saint-Germain','Inter','Mañana · 16:00',[1.85,3.60,4.20]),
match('cerundolo','tenis','ATP · Buenos Aires','F. Cerúndolo','S. Báez','Hoy · 18:00',[1.72,2.12]),
match('alcaraz','tenis','ATP · Madrid','C. Alcaraz','J. Sinner','2.º set',[1.65,2.30],true,'6–4 / 2–3'),
match('boca-obras','basquet','Argentina · Liga Nacional','Boca Juniors','Obras Basket','Hoy · 22:00',[1.80,2.05]),
match('nba','basquet','Estados Unidos · NBA','Boston Celtics','New York Knicks','3.er cuarto',[1.55,2.65],true,'74 : 69'),
{id:'palermo-5',sport:'hipica',league:'Palermo · Carrera 5 · 1.400 m',home:'Premio del Libertador',away:'Pista de arena · 8 participantes',time:'Hoy · 17:45',live:false,market:'Ganador de la carrera',selections:[{id:'horse-1',label:'1 · Gran Porteño',odds:3.5},{id:'horse-2',label:'2 · Luna del Sur',odds:4.8},{id:'horse-3',label:'3 · Don Valiente',odds:6.2}]},
{id:'sanisidro-7',sport:'hipica',league:'San Isidro · Carrera 7 · 1.600 m',home:'Clásico del Norte',away:'Pista de césped · 10 participantes',time:'Hoy · 18:20',live:false,market:'Ganador de la carrera',selections:[{id:'horse-4',label:'1 · Buen Camino',odds:2.9},{id:'horse-5',label:'2 · Cielo Abierto',odds:5.1},{id:'horse-6',label:'3 · Rey del Sol',odds:7.4}]}
];
export const demoSource: EventSource = {async getEvents(){return {mode:'demo',notice:'Datos ficticios. Cuotas y horarios ilustrativos. Sin apuestas ni dinero real.',events:structuredClone(demoEvents)}}};
