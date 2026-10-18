import {useEffect,useState} from 'react';
import type {TestTicket} from '@lsports/contracts';
export const ticketStatus = {PENDING:'Pendiente',WON:'Ganado',LOST:'Perdido',REFUNDED:'Reembolsado',PARTIAL_RETURN:'Retorno parcial'};
export function TicketHistory({refresh}: {refresh:number}) {
  const [data,setData] = useState<{tickets:TestTicket[];total:number;nextOffset:number|null}>();
  const [offset,setOffset] = useState(0);
  const [error,setError] = useState('');
  useEffect(()=>{
    let active=true;
    const load=async()=>{try {const r=await fetch(`/api/tickets?offset=${offset}`);if(!r.ok)throw Error();const d=await r.json();if(active){setData(d);setError('');}}catch{if(active)setError('No se pudo actualizar el historial.');}};
    void load();const timer=setInterval(load,5000);return()=>{active=false;clearInterval(timer);};
  },[refresh,offset]);
  return <section className="ticket-history"><h2>Historial de billetes de prueba</h2><p>Puntos ficticios · Sin dinero real. Los resultados pueden recibir correcciones del proveedor.</p>
    {error&&<p role="alert">{error}</p>}
    {data?.tickets.length===0&&<p>Todavía no registraste billetes de prueba.</p>}
    {data?.tickets.map(ticket=><details key={ticket.id}><summary>{ticketStatus[ticket.status]} · {(ticket.stakeMinor/100).toFixed(2)} pts · {new Date(ticket.createdAt).toLocaleString('es-AR')} · {ticket.mode}</summary>
      <p>ID: <code>{ticket.id}</code> · Revisión {ticket.revision}<br/>Retorno simulado: {ticket.payoutMinor===null?'Pendiente':`${(ticket.payoutMinor/100).toFixed(2)} pts`}</p>
      <ul>{ticket.selections.map(s=><li key={s.selectionId}>{s.eventName} · {s.marketName}<br/><strong>{s.selectionName}</strong> · Cuota aceptada {s.acceptedOdds} · {s.resultDescription}</li>)}</ul>
      <ol>{ticket.history.map(h=><li key={h.revision}>{new Date(h.at).toLocaleString('es-AR')} · {ticketStatus[h.status]} · {h.reason}</li>)}</ol>
      <a href={`/api/tickets/${ticket.id}/receipt`} target="_blank" rel="noreferrer">Abrir / imprimir comprobante de prueba</a>
    </details>)}
    {offset>0&&<button onClick={()=>setOffset(Math.max(0,offset-50))}>Anteriores</button>}
    {data?.nextOffset!==null&&data?.nextOffset!==undefined&&<button onClick={()=>setOffset(data.nextOffset!)}>Más billetes</button>}
  </section>;
}
