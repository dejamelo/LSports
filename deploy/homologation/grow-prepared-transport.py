"""Pinned 184-GiB filesystem growth. Never modifies EBS or service state."""
import hashlib,json,os,shutil,subprocess,sys,urllib.request
from pathlib import Path
BACKUP=Path('/var/backups/adl-partitioned-upgrade-p1znn7u6')
IMAGE='adl-worker-partitioned:f8be504232d690d3045c77cc'
VOLUME='vol-03fa30ff2fc37a28e';INSTANCE='i-04690a17692088df9';REGION='us-east-2';TARGET=184*1024**3
EXPECTED={'connected.ts':'472de553b82fc832e43dc4077de95f53a5d74e5e6220f11fa5f7b36b1efbd67c','connection-closer.ts':'3009825734fb5cf206b061dc1628897d0cc10670ba3d3e0296d7068602c325af','durable-ingress.mjs':'62ddea79a4d0c634ff2f2107b73452aa7bc4711c34b83282088e8c49aec19d16','durable-ingress.d.mts':'6cf96bb15e2d2f3b1695ac32cc4336fa304e4cb47154cd608ce7227465036ed8'}
def emit(**r):print(json.dumps(r),flush=True)
def require(condition,reason):
 if not condition:raise RuntimeError(reason)
def run(args,timeout=30):
 p=subprocess.run(args,capture_output=True,timeout=timeout)
 require(p.returncode==0,'COMMAND_FAILED_'+Path(args[0]).name+'_'+str(p.returncode));return p.stdout

def verify_target(identity,serial,device_bytes):
 volume=serial.strip();volume=volume if volume.startswith('vol-') else 'vol-'+volume[3:]
 require(identity.get('instanceId')==INSTANCE and identity.get('region')==REGION and volume==VOLUME,'INSTANCE_VOLUME_ASSOCIATION_MISMATCH_NO_GROWTH')
 require(device_bytes>=TARGET,'EBS_184_GIB_NOT_VISIBLE_NO_FILESYSTEM_GROWTH')
 return volume

def private_json(path):
 require(path.is_file() and not path.is_symlink() and path.stat().st_uid==0 and path.stat().st_mode&0o077==0 and path.stat().st_size<2*1024**2,'PROTECTED_RECEIPT_UNVERIFIED');return json.loads(path.read_bytes())
def main():
 require(os.geteuid()==0,'ROOT_REQUIRED')
 for name in ('docker','findmnt','lsblk','blockdev','growpart','resize2fs'):require(shutil.which(name),'MISSING_TOOL_'+name)
 require(BACKUP.is_dir() and not BACKUP.is_symlink() and BACKUP.stat().st_uid==0 and BACKUP.stat().st_mode&0o077==0,'BACKUP_IDENTITY_UNVERIFIED')
 receipt=private_json(Path('/etc/adl-homologation/partitioned-upgrade-f8be504232d690d3045c77cc.json'))
 require(receipt.get('backup')==str(BACKUP) and receipt.get('image')==IMAGE and receipt.get('phase') in ('stopped','start_requested','running'),'PREPARATION_IDENTITY_OR_PHASE_UNVERIFIED')
 c=json.loads(run(['docker','inspect','adl-homologation-worker-1']))[0]
 require(c['Id']==receipt.get('oldContainer') and not c['State']['Running'] or receipt.get('phase') in ('start_requested','running') and c['Config']['Image']==IMAGE,'CONTAINER_IDENTITY_CHANGED_NO_GROWTH')
 if receipt.get('phase')=='stopped':require(receipt.get('preExitProof',{}).get('verified') is True and receipt.get('verifiedExitContainerId')==c['Id'],'COMPLETED_FINALIZATION_PROOF_UNVERIFIED')
 image=json.loads(run(['docker','image','inspect',IMAGE]))[0]
 require((image.get('Config',{}).get('Labels') or {}).get('eu.adl.partitioned.patch')==receipt.get('digest') and str(receipt.get('digest','')).startswith('f8be504232d690d3045c77cc'),'PREPARED_IMAGE_DIGEST_UNVERIFIED')
 script="const fs=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify(Object.fromEntries("+json.dumps(list(EXPECTED))+".map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/apps/worker/src/'+n)).digest('hex')]))))"
 actual=json.loads(run(['docker','run','--rm','--network','none','--memory','128m','--read-only','--entrypoint','node',image['Id'],'-e',script]))
 require(actual==EXPECTED,'PREPARED_7B8BF4B_SOURCE_MISMATCH_NO_GROWTH')
 emit(stage='prepared_source_verified',status='verified',expectedRevision='7b8bf4b',image=IMAGE,imageId=image['Id'],fourSourceHashes=actual,workerStarted=False)
 request=urllib.request.Request('http://169.254.169.254/latest/api/token',method='PUT',headers={'X-aws-ec2-metadata-token-ttl-seconds':'60'})
 with urllib.request.urlopen(request,timeout=5) as response:token=response.read().decode()
 request=urllib.request.Request('http://169.254.169.254/latest/dynamic/instance-identity/document',headers={'X-aws-ec2-metadata-token':token})
 with urllib.request.urlopen(request,timeout=5) as response:identity=json.load(response)
 device_bytes=int(run(['blockdev','--getsize64','/dev/nvme0n1']));serial=Path('/sys/class/block/nvme0n1/device/serial').read_text()
 verify_target(identity,serial,device_bytes)
 fs=json.loads(run(['findmnt','--json','--bytes','--target',str(BACKUP),'--output','SOURCE,TARGET,FSTYPE,SIZE,AVAIL']))['filesystems'][0]
 require(str(fs['source']).split('[')[0]=='/dev/nvme0n1p1' and fs['fstype']=='ext4' and fs['target']=='/','ROOT_EXT4_MOUNT_MISMATCH_NO_GROWTH')
 require(Path('/sys/class/block/nvme0n1p1/partition').read_text().strip()=='1','PARTITION_NUMBER_UNVERIFIED')
 emit(stage='ebs_attachment_verified',status='verified',instanceId=INSTANCE,region=REGION,volumeId=VOLUME,deviceBytes=device_bytes,partitionBytes=int(run(['blockdev','--getsize64','/dev/nvme0n1p1'])),filesystem=fs,targetEbsGiB=184,workerMutationRequested=False)
 p=subprocess.run(['growpart','/dev/nvme0n1','1'],capture_output=True,timeout=90)
 require(p.returncode==0 or p.returncode==1 and p.stdout.startswith(b'NOCHANGE:'),'GROWPART_FAILED_NO_RESIZE')
 emit(stage='partition_growth',status='changed' if p.returncode==0 else 'already_expanded',partitionBytes=int(run(['blockdev','--getsize64','/dev/nvme0n1p1'])))
 run(['resize2fs','/dev/nvme0n1p1'],timeout=120)
 usage=shutil.disk_usage(BACKUP)
 emit(stage='filesystem_growth',status='verified',filesystemTotalBytes=usage.total,availableFreeBytes=usage.free,workerStarted=False,posnetChanged=False,note='Resume preflight recalculates deficit against the protected saved disk plan.')
try:main()
except Exception as e:
 emit(stage='filesystem_growth',status='blocked',reason=str(e) if isinstance(e,RuntimeError) else 'FILESYSTEM_PREPARATION_FAILED',exceptionType=type(e).__name__,workerStarted=False,posnetChanged=False);sys.exit(2)
