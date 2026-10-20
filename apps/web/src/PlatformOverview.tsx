import {useEffect,useState} from 'react';
type Api=(path:string)=>Promise<any>;
export default function PlatformOverview({api,sportsbook=false}:{api:Api;sportsbook?:boolean}){
 const [data,setData]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[open,setOpen]=useState(false);
 async function load(){setBusy(true);setError('');try{setData(await api('/feed-overview'));}catch(e){setError(e instanceof Error?e.message:'No se pudo consultar el feed.');}finally{setBusy(false);}}
 useEffect(()=>{void load();},[]);
 return <section className="control-card"><h2>{sportsbook?'Sportsbook · vista de plataforma':'Estado de la plataforma'}</h2>
 <p>Consulta local · Sin credencial de integración ni operación ficticia. No permite registrar billetes.</p>
 {busy&&<p role="status">Consultando datos locales…</p>}{error&&<p role="alert" className="control-error">{error}</p>}
 {data&&<><p role="status">{data.selectableSelections>0?'Hay selecciones disponibles en el feed; esta vista es solo lectura.':data.lanes.every((l:any)=>l.phase==='connected')?'Feed conectado, sin cuotas habilitadas para nuevas apuestas.':'Feed no disponible para nuevas apuestas. No hay cuotas habilitadas.'}</p>
 <ul>{data.lanes.map((l:any)=><li key={l.lane}>{l.lane==='prematch'?'PreMatch':'InPlay'} · {l.phase}{l.diagnostic?.amqpCode?` · AMQP ${l.diagnostic.amqpCode}`:''}{l.diagnostic?.reason?` · ${l.diagnostic.reason}`:''}</li>)}</ul>
 <p>{data.events} eventos almacenados · {data.selectableSelections} selecciones disponibles. Almacenado no significa actual.</p></>}
 <button disabled={busy} onClick={()=>void load()}>Actualizar estado local</button>
 {sportsbook&&<><button onClick={()=>setOpen(!open)}>{open?'Cerrar sportsbook de solo lectura':'Abrir sportsbook de solo lectura'}</button>{open&&<><p>Para simular billetes, seleccioná cliente y operación, autorizá este origen y generá una credencial vigente. El backend debe validar el feed.</p><iframe title="Sportsbook de plataforma · solo lectura" src="/control/sportsbook-preview" style={{width:'100%',height:'800px',maxHeight:'85vh',border:0}}/></>}</>}
 </section>;
}
