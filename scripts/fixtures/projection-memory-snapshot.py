import argparse,json,os
parser=argparse.ArgumentParser(description='Generate isolated dense projection regression snapshot; never use a production path.')
parser.add_argument('output')
path=parser.parse_args().output
with open(path,'xb') as f:
 f.write(b'{"Header":{"HttpStatusCode":200},"Body":[')
 for i in range(1,16330):
  at='2026-10-21T03:45:31.763Z'
  markets=[{'Id':m,'Name':f'Mercado representativo {m}','Status':1 if m%4 else 2,'LastUpdate':at,'Bets':[{'Id':str(b),'Name':f'Seleccion representativa {i}-{m}-{b}','Price':'2.15','Status':1 if b%5 else 2,'Settlement':2 if b==12 else 0,'IsChanged':1,'LastUpdate':at} for b in range(1,13)]} for m in range(1,13)]
  raw={'FixtureId':i,'Fixture':{'Status':1,'LastUpdate':at,'Sport':{'Id':6046,'Name':'Football'},'Participants':[{'Id':i*2,'Position':'1','Name':'Equipo local'},{'Id':i*2+1,'Position':'2','Name':'Equipo visitante'}]},'Markets':markets}
  f.write((b',' if i>1 else b'')+json.dumps(raw,separators=(',',':')).encode())
 f.write(b']')
 remaining=516000000-f.tell()-1
 if remaining<0:raise Exception('structured size exceeded target')
 structured=f.tell()+1
 while remaining:
  size=min(remaining,1024*1024);f.write(b' '*size);remaining-=size
 f.write(b'}')
print(json.dumps({'rows':16329,'markets':195948,'selections':2351376,'structuredBytes':structured,'fileBytes':os.stat(path).st_size}))
