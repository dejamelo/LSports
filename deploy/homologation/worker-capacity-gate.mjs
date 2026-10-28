// Accept measured worker memory profiles only with the saved capacity and stopped-consumer gates.
export function workerCapacityApproved(model,{repairSnapshot=false,pipelineMemoryEightGiB=false,snapshotMemoryEightGiB=false}={}){
 if(!model||model.gates?.capacityApproved!==true||model.gates?.macStopped!==true||model.gates?.notBeforeConfigured!==true)return false;
 const memory=String(model.memoryLimitBytes);
 const prematch=String(model.prematchCapMB),inplay=String(model.inplayCapMB);
 const memoryAccepted=repairSnapshot
  ? memory==='2147483648'||memory==='4294967296'
  : memory==='4294967296'||memory==='6442450944'||(pipelineMemoryEightGiB||snapshotMemoryEightGiB)&&memory==='8589934592';
 return memoryAccepted&&(['256'].includes(prematch)||repairSnapshot&&prematch==='128')&&['128','256'].includes(inplay);
}
