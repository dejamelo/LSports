import json,unittest,ssl,socket,io,contextlib
from pathlib import Path
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from threading import Thread
HERE=Path(__file__).parent
s={'__name__':'fixture'}
for name in ('resume-adl-api.py','publish-adl-https.py','verify-adl-https.py'):
 exec((HERE/name).read_text().split("if __name__=='__main__':")[0],s)
class HTTPSInspection(unittest.TestCase):
 def test_real_built_asset_extracted(self):
  self.assertEqual(s['asset_from_html']('<html><script type="module" crossorigin src="/assets/index-Yq1.js"></script></html>'),'/assets/index-Yq1.js')
 def test_does_not_follow_absolute_asset_url(self):
  with self.assertRaises(ValueError):s['asset_from_html']('<script src="https://other.example/assets/index.js"></script>')
 def test_log_sanitization_and_domain_scope(self):
  rows=[{'ts':123,'level':'error','identifier':s['DOMAIN'],'error':'challenge failed: unauthorized https://secret:password@ca/account/123'},
        {'ts':124,'identifier':'posnet.invalid','msg':'certificate obtained successfully'},
        {'ts':125,'identifier':s['DOMAIN'],'msg':'certificate obtained successfully'}]
  result=s['certificate_log_events']('\n'.join(map(json.dumps,rows)).encode())
  self.assertEqual(len(result),2);self.assertIn('challenge_failed',result[0]['signals']);self.assertEqual(result[1]['signals'],['certificate_obtained'])
  self.assertNotIn('password',str(result));self.assertNotIn('account',str(result))
 def test_tls_errors_are_distinguished(self):
  for error,category in ((ssl.SSLCertVerificationError(),'certificate_verification_failed'),(socket.gaierror(),'dns_resolution_failed'),(ConnectionRefusedError(),'connection_refused'),(TimeoutError(),'connection_timeout')):
   with patch('socket.create_connection',side_effect=error):self.assertEqual(s['tls_probe']('example.invalid')['category'],category)
 def test_http_status_and_redirect_are_not_hidden(self):
  class Handler(BaseHTTPRequestHandler):
   def do_GET(self):
    self.send_response(302 if self.path=='/redirect' else 404)
    self.send_header('Location','http://invalid.example/never-follow')
    self.end_headers()
   def log_message(self,*args):pass
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   base='http://127.0.0.1:'+str(server.server_port)
   self.assertEqual(s['http_probe'](base+'/sportsbook')['httpStatus'],404)
   self.assertEqual(s['http_probe'](base+'/redirect')['httpStatus'],302)
  finally:server.shutdown();server.server_close();thread.join()
 def test_existing_site_verifier_never_mutates(self):
  code=(HERE/'verify-adl-https.py').read_text()
  self.assertNotIn('reload(',code);self.assertNotIn('write_host(',code)
  self.assertNotIn("'up'",code);self.assertNotIn('CERT_NONE',code)
 def test_publication_no_longer_requires_legacy_sportsbook(self):
  code=(HERE/'publish-adl-https.py').read_text()
  self.assertNotIn("DOMAIN+'/sportsbook'",code)
  self.assertIn("DOMAIN+assets[0]",code)
if __name__=='__main__':unittest.main()
