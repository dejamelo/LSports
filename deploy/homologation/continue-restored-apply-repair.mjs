// Derive the state-memory repair from the protected, stopped g2uant6r preparation.
import{spawnSync}from'node:child_process';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';
const here=dirname(fileURLToPath(import.meta.url)),env={...process.env};
for(const name of ['ADL_RESUME_BACKUP','ADL_FINALIZE_VERIFIED_SHUTDOWN','ADL_LIVE_OOM_REPAIR','ADL_EXPECTED_OOM_PREFIX','ADL_LIVE_PERSISTENCE_REPAIR','ADL_SNAPSHOT_PRESSURE_REPAIR','ADL_EXPECTED_LIVE_IMAGE'])delete env[name];
env.ADL_CHECKPOINT_REPAIR_BACKUP='/var/backups/adl-partitioned-upgrade-g2uant6r';
console.log('Etapa: derivar imagem corrigida da preparação protegida g2uant6r; reutilizar parada, backup e dados originais.');
console.log('Etapa obrigatória: restauração + snapshot HTTP preservado completo + serialização + releitura, heap 2560 MiB/container 4 GiB; iniciar feeds somente após aprovação.');
const r=spawnSync(process.execPath,[join(here,'complete-adl-cutover.mjs'),'--pid','12811','--parent','12809','--snapshot-memory-repair'],{env,stdio:'inherit'});process.exitCode=r.status??2;
