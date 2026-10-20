"""Small argv bootstrap. Code + request arrive over stdin, never a Linux-sized argv."""
import sys,json,io,subprocess,errno
stage='envelope'
def emit(**v):print(json.dumps({'operation':'cutover.helper','status':'blocked','helperStage':stage,**v}),flush=True)
try:
 raw=sys.stdin.buffer.read(8*1024*1024+1)
 if len(raw)>8*1024*1024:raise ValueError()
 envelope=json.loads(raw);source=envelope['source'];request=envelope['request']
 if not isinstance(source,str) or len(source.encode())>512*1024 or not isinstance(request,dict):raise ValueError()
 stage='compile';program=compile(source,'<adl-worker-helper>','exec')
 stage='execute';sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()),encoding='utf8')
 exec(program,{'__name__':'__main__'})
except SystemExit as error:
 code=error.code if type(error.code) is int else 0 if error.code is None else 2
 raise SystemExit(code if 0<=code<=255 else 2)
except BaseException as error:
 kind=type(error).__name__;allowed={'SyntaxError','IndentationError','TabError','MemoryError','ModuleNotFoundError','ImportError','FileNotFoundError','PermissionError','CalledProcessError','TimeoutExpired','JSONDecodeError','ValueError','KeyError','TypeError','NameError','UnboundLocalError','RuntimeError','OSError'}
 detail={'reason':{'envelope':'REMOTE_HELPER_ENVELOPE_REJECTED','compile':'REMOTE_HELPER_COMPILE_FAILED','execute':'REMOTE_HELPER_EXECUTION_FAILED'}[stage],'exceptionType':kind if kind in allowed else 'other','rawExceptionPrinted':False}
 if isinstance(error,SyntaxError):detail.update(line=error.lineno,column=error.offset)
 if isinstance(error,subprocess.CalledProcessError):detail['childExitCode']=error.returncode
 if isinstance(error,OSError) and error.errno in (errno.E2BIG,errno.ENOENT,errno.EACCES,errno.ENOMEM):detail['osCode']=errno.errorcode[error.errno]
 emit(**detail);raise SystemExit(2)
