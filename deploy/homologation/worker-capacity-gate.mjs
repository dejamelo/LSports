// Accept only the explicitly approved worker memory profiles. A 6 GiB
// container is valid when the saved capacity and stopped-consumer gates are on.
export function workerCapacityApproved(model,{repairSnapshot=false}={}){
 if(!model||model.gates?.capacityApproved!==true||model.gates?.macStopped!==true||model.gates?.notBeforeConfigured!==true)return false;
 const memory=String(model.memoryLimitBytes);
 const prematch=String(model.prematchCapMB),inplay=String(model.inplayCapMB);
 const memoryAccepted=repairSnapshot
  ? memory==='2147483648'||memory==='4294967296'
  : memory==='4294967296'||memory==='6442450944';
 return memoryAccepted&&(['256'].includes(prematch)||repairSnapshot&&prematch==='128')&&['128','256'].includes(inplay);
}
