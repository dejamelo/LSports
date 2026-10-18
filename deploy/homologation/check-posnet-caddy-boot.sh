#!/usr/bin/env bash
# READ ONLY. Stream over SSH; prints hashes/status only, never config values.
set -u
command -v python3 >/dev/null || { echo 'python3_missing'; exit 2; }
exec python3 - <<'PY'
import hashlib
import json
import os
import subprocess

CADDY='e0428b3131b3a9df39da17744e2bf3b8a8ba0ee74c070f6184077806973362e2'
EXPECTED='/home/ubuntu/pixel-lottery-hub/deploy/Caddyfile.production'

def emit(**v): print(json.dumps(v),flush=True)
def read(args,stage):
    try: p=subprocess.run(args,capture_output=True,timeout=20,check=False)
    except (OSError,subprocess.TimeoutExpired):
        emit(stage=stage,status='unverified',reason='command_unavailable_or_timeout'); return None
    if p.returncode:
        emit(stage=stage,status='unverified',reason='command_failed',exitCode=p.returncode); return None
    return p.stdout

def digest(obj): return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def load(raw,stage):
    try:
        obj=json.loads(raw)
        if not isinstance(obj,dict): raise ValueError()
        return obj
    except (ValueError,TypeError):
        emit(stage=stage,status='unverified',reason='invalid_json_object'); return None

def main():
    raw=read(['docker','inspect',CADDY],'inspect')
    if raw is None: return 2
    try:
        items=json.loads(raw)
        if len(items)!=1 or items[0].get('Name')!='/deploy-caddy-production-1': raise ValueError()
        item=items[0]
    except (ValueError,TypeError,KeyError):
        emit(stage='identity',status='unverified'); return 2
    cfg=item.get('Config') or {}
    argv=(cfg.get('Entrypoint') or [])+(cfg.get('Cmd') or [])
    # Do not print argv: it can carry secrets. Shell wrappers require separate review.
    if not isinstance(argv,list) or not argv or os.path.basename(argv[0])!='caddy' or len(argv)<2 or argv[1]!='run':
        emit(stage='startup',status='unverified',reason='nonstandard_entrypoint'); return 2
    def flag(name):
        for i,arg in enumerate(argv):
            if arg==name: return argv[i+1] if i+1<len(argv) else None
            if arg.startswith(name+'='): return arg.split('=',1)[1]
        return None
    resume=any(a=='--resume' or a.startswith('--resume=') for a in argv)
    if resume:
        emit(stage='startup',status='unverified',reason='resume_requires_autosave_review',note='Do not assume mounted Caddyfile is used. No changes performed.'); return 2
    path=flag('--config')
    adapter=flag('--adapter') or ('caddyfile' if path and os.path.basename(path).lower().startswith('caddyfile') else None)
    if path!='/etc/caddy/Caddyfile' or adapter!='caddyfile':
        emit(stage='startup',status='unverified',reason='unexpected_config_path_or_adapter'); return 2
    binds=[m for m in item.get('Mounts',[]) if m.get('Destination')==path and m.get('Type')=='bind']
    if len(binds)!=1 or binds[0].get('Source')!=EXPECTED:
        emit(stage='mount',status='unverified',reason='unexpected_bind_source'); return 2
    mounted=read(['docker','exec',CADDY,'cat',path],'mounted_file')
    try:
        with open(EXPECTED,'rb') as f: host=f.read(2*1024*1024+1)
        if len(host)>2*1024*1024: raise ValueError()
    except (OSError,ValueError):
        emit(stage='host_file',status='unverified',reason='unreadable_or_size_limit'); return 2
    if mounted is None: return 2
    same=host==mounted
    emit(stage='mount',status='ok' if same else 'mismatch',hostMatchesMounted=same,
         hostSha256=hashlib.sha256(host).hexdigest(),mountedSha256=hashlib.sha256(mounted).hexdigest())
    active=load(read(['docker','exec',CADDY,'wget','-qO-','-T','5','http://127.0.0.1:2019/config/'],'active_config'),'active_json')
    adapted=load(read(['docker','exec',CADDY,'caddy','adapt','--config',path,'--adapter','caddyfile'],'startup_adapt'),'adapted_json')
    if active is None or adapted is None: return 2
    equivalent=active==adapted
    emit(stage='comparison',status='equal' if equivalent else 'different',
         activeSha256=digest(active),startupSha256=digest(adapted),readOnly=True,
         differencesRequireReview=not equivalent,
         note='Canonical JSON comparison preserves array order; no reload or validation/provisioning performed. Equality is not a reboot test.')
    emit(stage='boot_gate',status='config_matches_now' if equivalent and same else 'blocked',
         note='Also verify Docker enabled, backend policies, persistent imports/secrets and post-boot health. No instance stop authorized.')
    return 0 if equivalent and same else 2

if __name__=='__main__': raise SystemExit(main())
PY
