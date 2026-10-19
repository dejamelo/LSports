import contextlib,io,json,tempfile,types,unittest,hashlib
from pathlib import Path
HERE=Path(__file__).parent
class PatchImage(unittest.TestCase):
 def test_derived_image_permissions_worker_only_overlay_reuse_and_no_consumer_start(self):
  ns={'__name__':'test'}
  for name in ('resume-adl-api.py','patch-adl-worker-image.py','execute-adl-cutover-aws.py'):exec((HERE/name).read_text().split("if __name__=='__main__':")[0],ns)
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);secure=root/'secure';secure.mkdir();releases=root/'releases';release=releases/('a'*40);release.mkdir(parents=True);backups=root/'backups';backups.mkdir()
   original=secure/'saved.json';original.write_text('{}');meta={'release':str(release),'composeOverrides':[str(original)],'image':'api-image-preserved'};(secure/'deployment.json').write_text(json.dumps(meta))
   files={'connected.ts':'import {connectionCloser} from "./connection-closer.js";','connection-closer.ts':'export const connectionCloser=()=>{};'};digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();tag='adl-worker-cutover:'+digest[:24];commands=[];images={'fixed-base':{'Id':'sha256:'+('b'*64),'Config':{'Labels':{}}}}
   def model(base):
    worker='fixed-base'
    for entry in base:
     if str(entry).startswith(str(secure/'compose.worker-close-')):worker=json.loads(Path(entry).read_text())['services']['worker']['image']
    return {'services':{'api':{'image':'api-image-preserved'},'worker':{'image':worker}}}
   def run(args,**kwargs):
    commands.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([images[args[3]]]).encode()
    if args[:2]==['docker','tag']:images[args[3]]=images['fixed-base'];return b''
    if args[:2]==['docker','run']:return b'offline-close-ok' if '--input-type=module' in args else b'base-source-hash'
    if args[:2]==['docker','build']:
     text=(Path(args[-1])/'Dockerfile').read_text();self.assertIn('COPY --chown=node:node --chmod=644',text);self.assertNotIn('FROM sha256:',text);self.assertTrue(text.endswith('USER node\n'));images[tag]={'Id':'sha256:'+('c'*64),'Config':{'Labels':{'eu.adl.cutover.patch':digest}}};return b''
    raise AssertionError('Unexpected command')
   os=types.SimpleNamespace(**ns['os'].__dict__);os.geteuid=lambda:0
   ns.update(SECURE=secure,RELEASES=releases,BACKUPS=backups,run=run,model=model,os=os,states=lambda service:[],subprocess=types.SimpleNamespace(run=lambda *a,**k:types.SimpleNamespace(returncode=1)))
   def invoke():
    out=io.StringIO()
    with contextlib.redirect_stdout(out):code=ns['patch_worker']({'patch':{'baseConnectedSha256':'base-source-hash','files':files}})
    return code,json.loads(out.getvalue())
   code,result=invoke();self.assertEqual(code,0,result);self.assertTrue(result['offlineCloseVerified']);after=json.loads((secure/'deployment.json').read_text());self.assertEqual(after['image'],meta['image']);self.assertEqual(after['composeOverrides'][0],str(original));self.assertEqual(len(after['composeOverrides']),2)
   builds=sum(c[:2]==['docker','build'] for c in commands);code,result=invoke();self.assertEqual(code,0,result);self.assertTrue(result['reused']);self.assertEqual(sum(c[:2]==['docker','build'] for c in commands),builds)
   for command in commands:self.assertNotIn('up',command);self.assertNotIn('stop',command);self.assertNotIn('restart',command)
if __name__=='__main__':unittest.main()
