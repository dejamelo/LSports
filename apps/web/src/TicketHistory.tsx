import { sportsbookApi, embedded } from "./sportsbook-api";
import {useEffect,useState,useRef} from 'react';
import {formatMinor,type OperationTicket,type TestTicket} from '@lsports/contracts';
const display=(ticket:TestTicket|OperationTicket,value:string|number|null)=>value===null?'Pendiente':ticket.currency==='TEST_POINTS'?`${(Number(value)/100).toFixed(2)} pts`:formatMinor(String(value),ticket.currency);
export const ticketStatus = {PENDING:'Pendiente',WON:'Ganado',LOST:'Perdido',REFUNDED:'Reembolsado',PARTIAL_RETURN:'Retorno parcial'};
export function TicketHistory({refresh,focusTicketId}: {refresh:number;focusTicketId?:string}) {
  const [data,setData] = useState<{tickets:(TestTicket|OperationTicket)[];total:number;nextOffset:number|null}>();
  const [offset,setOffset] = useState(0);
  const [error,setError] = useState('');
  const [receipt,setReceipt]=useState('');
  const frame=useRef<HTMLIFrameElement>(null);
  useEffect(()=>{
    let active=true;
    const load=async()=>{try {const r=await sportsbookApi(`/tickets?offset=${offset}`);if(!r.ok)throw Error();const d=await r.json();if(active){setData(d);setError('');}}catch{if(active)setError('No se pudo actualizar el historial.');}};
    void load();const timer=setInterval(load,5000);return()=>{active=false;clearInterval(timer);};
  },[refresh,offset]);
  useEffect(()=>{if(focusTicketId && data){const item=document.getElementById(`ticket-${focusTicketId}`) as HTMLDetailsElement|null;if(item){item.open=true;item.scrollIntoView({block:"start"});}}},[focusTicketId,data]);
  return <section className="ticket-history"><h2>Historial de billetes de prueba</h2><p>Simulación · Sin dinero real. Los resultados pueden recibir correcciones del proveedor.</p>
    {error&&<p role="alert">{error}</p>}
    {data?.tickets.length===0&&<p>Todavía no registraste billetes de prueba.</p>}
    {data?.tickets.map(ticket=><details key={ticket.id} id={`ticket-${ticket.id}`}><summary>{ticketStatus[ticket.status]} · {display(ticket,ticket.stakeMinor)} · {new Date(ticket.createdAt).toLocaleString('es-AR')} · {ticket.mode}</summary>
      <p>ID: <code>{ticket.id}</code> · Revisión {ticket.revision}<br/>Retorno simulado: {display(ticket,ticket.payoutMinor)}</p>
      <ul>{ticket.selections.map(s=><li key={s.selectionId}>{s.eventName} · {s.marketName}<br/><strong>{s.selectionName}</strong> · Cuota aceptada {s.acceptedOdds} · {s.resultDescription}</li>)}</ul>
      <ol>{ticket.history.map(h=><li key={h.revision}>{new Date(h.at).toLocaleString('es-AR')} · {ticketStatus[h.status]} · {h.reason}</li>)}</ol>
      {embedded?<button onClick={()=>void sportsbookApi(`/tickets/${ticket.id}/receipt`).then(async response=>{if(!response.ok)throw Error();setReceipt(await response.text());}).catch(()=>setError('No se pudo abrir el comprobante.'))}>Abrir / imprimir comprobante de prueba</button>:<a href={`/api/tickets/${ticket.id}/receipt`} target="_blank" rel="noreferrer">Abrir / imprimir comprobante de prueba</a>}
    </details>)}
    {receipt&&<dialog open className="receipt-dialog"><p>SIMULACIÓN · Imprimir o reimprimir no genera otra apuesta. La impresión física no está confirmada por el navegador.</p><div><button onClick={()=>frame.current?.contentWindow?.print()}>Imprimir comprobante</button><button onClick={()=>setReceipt('')}>Cerrar</button></div><iframe ref={frame} title="Comprobante · Apuesta DEPORTIVA LAT" sandbox="allow-same-origin allow-modals" srcDoc={receipt}/></dialog>}
    {offset>0&&<button onClick={()=>setOffset(Math.max(0,offset-(embedded?30:50)))}>Anteriores</button>}
    {data?.nextOffset!==null&&data?.nextOffset!==undefined&&<button onClick={()=>setOffset(data.nextOffset!)}>Más billetes</button>}
  </section>;
}
