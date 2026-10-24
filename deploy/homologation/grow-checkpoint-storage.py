"""Expand only the already-grown, pinned EBS root partition/filesystem; no service mutation."""
import json,re,shutil,subprocess,sys
from pathlib import Path
MIN_DEVICE_BYTES=288*1024**3

def run(args,timeout=20):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError('COMMAND_FAILED_'+Path(args[0]).name.upper())
 return r.stdout

def target(filesystem,devices):
 f=filesystem.get('filesystems',[])
 if len(f)!=1 or f[0].get('source')!='/dev/nvme0n1p1' or f[0].get('fstype')!='ext4' or f[0].get('target')!='/':raise RuntimeError('ROOT_FILESYSTEM_IDENTITY_UNVERIFIED')
 disks=[d for d in devices.get('blockdevices',[]) if d.get('name')=='nvme0n1' and d.get('type')=='disk' and d.get('serial')=='vol03fa30ff2fc37a28e']
 if len(disks)!=1:raise RuntimeError('ROOT_EBS_SERIAL_UNVERIFIED')
 children=[d for d in disks[0].get('children',[]) if d.get('name')=='nvme0n1p1' and '/' in (d.get('mountpoints') or [])]
 if len(children)!=1:raise RuntimeError('ROOT_PARTITION_UNVERIFIED')
 return int(disks[0]['size']),int(children[0]['size'])

def main():
 fs=json.loads(run(['findmnt','--json','--bytes','--target','/','--output','SOURCE,TARGET,FSTYPE,SIZE,AVAIL']))
 devices=json.loads(run(['lsblk','--json','--bytes','--output','NAME,SIZE,TYPE,SERIAL,MOUNTPOINTS']))
 size,part=target(fs,devices)
 identity={'region':'us-east-2','expectedInstanceId':'i-04690a17692088df9','volumeId':'vol-03fa30ff2fc37a28e','device':'/dev/nvme0n1','partition':'/dev/nvme0n1p1','deviceBytes':size,'partitionBytes':part}
 tag=Path('/sys/devices/virtual/dmi/id/board_asset_tag')
 if tag.is_file():
  value=tag.read_text().strip()
  if re.fullmatch('i-[0-9a-f]{8,17}',value) and value!=identity['expectedInstanceId']:raise RuntimeError('INSTANCE_ID_DIFFERS_NO_ACTION')
 print(json.dumps({'stage':'root_storage_identity',**identity,'workerMutationRequested':False}),flush=True)
 if size<MIN_DEVICE_BYTES:
  print(json.dumps({'stage':'storage_capacity_gate','status':'blocked','reason':'EBS_EXPANSION_REQUIRED_NO_WORKER_CHANGE','currentGiB':size//1024**3,'requiredDeviceGiB':288,'console':'EC2 > us-east-2 > Volumes > vol-03fa30ff2fc37a28e; confirm attachment to i-04690a17692088df9, then Modify volume size to 288 GiB; preserve type, IOPS and throughput. Re-run after device expansion is visible.','signalsSent':0}),flush=True);return 2
 # Dry-run can only lead to the one verified root partition. Never retry signals.
 dry=subprocess.run(['growpart','-N','/dev/nvme0n1','1'],capture_output=True,text=True,timeout=20)
 if dry.returncode==0 and 'CHANGE:' in dry.stdout:
  run(['growpart','/dev/nvme0n1','1']);print(json.dumps({'stage':'partition_growth','status':'applied'}),flush=True)
 elif dry.returncode==1 and 'NOCHANGE:' in dry.stdout:print(json.dumps({'stage':'partition_growth','status':'already_complete'}),flush=True)
 else:raise RuntimeError('GROWPART_DRY_RUN_UNVERIFIED_NO_RETRY')
 devices=json.loads(run(['lsblk','--json','--bytes','--output','NAME,SIZE,TYPE,SERIAL,MOUNTPOINTS']));_,part=target(fs,devices)
 header=run(['dumpe2fs','-h','/dev/nvme0n1p1']);count=re.search(r'^Block count:\s+(\d+)',header,re.M);block=re.search(r'^Block size:\s+(\d+)',header,re.M)
 if not count or not block:raise RuntimeError('EXT4_GEOMETRY_UNVERIFIED')
 if int(count[1])*int(block[1])<part-64*1024**2:
  run(['resize2fs','/dev/nvme0n1p1'],timeout=120);print(json.dumps({'stage':'filesystem_growth','status':'applied'}),flush=True)
 else:print(json.dumps({'stage':'filesystem_growth','status':'already_complete'}),flush=True)
 c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0]
 mounts=[m for m in c['Mounts'] if m.get('Destination')=='/app/.runtime/feed' and m.get('Type')=='volume']
 if len(mounts)!=1:raise RuntimeError('FEED_MOUNT_UNVERIFIED')
 directory=Path(mounts[0]['Source']);files=[p for p in directory.rglob('*') if p.is_file() and not p.is_symlink() and(p.name.startswith('trade-feed.json') or p.name=='response.private.json')]
 needed=sum(p.stat().st_size for p in files)*10+4*1024**3;free=shutil.disk_usage('/var/backups').free
 print(json.dumps({'stage':'storage_capacity_gate','status':'verified' if free>=needed else 'blocked','freeDiskBytes':free,'requiredFreeBytes':needed,'missingBytes':max(0,needed-free),'formulaUnchanged':True,'workerRestarted':False,'signalsSent':0}),flush=True)
 return 0 if free>=needed else 2
if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:
  print(json.dumps({'stage':'storage_growth','status':'blocked','reason':str(e) if isinstance(e,RuntimeError) else 'FILESYSTEM_GROWTH_FAILED','exceptionType':type(e).__name__,'workerMutationRequested':False}),flush=True);sys.exit(2)
