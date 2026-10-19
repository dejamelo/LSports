"""Read-only HTTPS/ACME inspection. Bundled after common and publish helpers; no reload."""
import ssl
import socket
import urllib.error
import hashlib

def tls_probe(host):
    try:
        with socket.create_connection((host,443),timeout=8) as raw:
            with ssl.create_default_context().wrap_socket(raw,server_hostname=DOMAIN) as tls:
                cert=tls.getpeercert()
                return {'verified':True,'protocol':tls.version(),'expiresAt':cert.get('notAfter'),
                        'sha256':hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest()}
    except ssl.SSLCertVerificationError:return {'verified':False,'category':'certificate_verification_failed'}
    except ssl.SSLError:return {'verified':False,'category':'tls_handshake_failed'}
    except socket.gaierror:return {'verified':False,'category':'dns_resolution_failed'}
    except (TimeoutError,socket.timeout):return {'verified':False,'category':'connection_timeout'}
    except ConnectionRefusedError:return {'verified':False,'category':'connection_refused'}
    except OSError:return {'verified':False,'category':'network_error'}

def http_probe(url):
    # No redirects: do not misclassify a redirect to another origin as ADL success.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    try:
        with urllib.request.build_opener(NoRedirect).open(url,timeout=8) as response:
            return {'httpStatus':response.status,'contentType':response.headers.get_content_type()}
    except urllib.error.HTTPError as error:
        return {'httpStatus':error.code,'contentType':error.headers.get_content_type()}
    except Exception:return {'httpStatus':None,'category':'request_failed'}

def asset_from_html(html):
    matches=re.findall(r'(?:src|href)=[\"\'](/assets/[a-zA-Z0-9_.-]+\.js)[\"\']',html)
    if not matches:raise ValueError('built_asset_missing')
    return matches[0]

def certificate_log_events(data):
    events=[]
    for line in data.decode(errors='replace').splitlines():
        if DOMAIN not in line:continue
        try:item=json.loads(line)
        except ValueError:continue
        # Only classify fixed categories; never expose raw message/error, challenge URLs or account IDs.
        text=json.dumps(item).lower();codes=[]
        rules={
            'certificate_obtained':'certificate obtained successfully' in text,
            'obtaining_certificate':'obtaining certificate' in text,
            'certificate_obtain_failed':'could not get certificate' in text or 'obtaining certificate' in text and item.get('level')=='error',
            'acme_rate_limited':'ratelimited' in text or 'rate limit' in text,
            'acme_dns_error':'nxdomain' in text or 'dns problem' in text,
            'acme_caa_error':'caa' in text and ('error' in text or 'forbidden' in text),
            'challenge_failed':'challenge failed' in text or 'unauthorized' in text,
            'connection_timeout':'timeout' in text or 'timed out' in text,
            'connection_refused':'connection refused' in text,
            'certificate_storage_denied':'permission denied' in text,
            'retry_scheduled':'will retry' in text,
        }
        codes=[key for key,found in rules.items() if found]
        if not codes:continue
        timestamp=item.get('ts');timestamp=timestamp if isinstance(timestamp,(int,float)) else None
        events.append({'timestamp':timestamp,'signals':codes})
    return events[-20:]

def verification():
    stage='https_inspect'
    try:
        meta=json.loads((SECURE/'deployment.json').read_bytes())
        if meta.get('domain')!=DOMAIN:raise ValueError()
        data=HOST.read_bytes()
        if len(data)>2*1024*1024:raise ValueError()
        configured=adapt(data);loaded=active()
        routes=[route for server in loaded.get('apps',{}).get('http',{}).get('servers',{}).values() for route in server.get('routes',[])]
        site_loaded=any(route.get('match')==[{'host':[DOMAIN]}] for route in routes)
        mounted=command(['docker','exec',CADDY,'cat','/etc/caddy/Caddyfile'])==data
        overrides=all(Path(p).parent==SECURE and not Path(p).is_symlink() and Path(p).is_file() for p in meta.get('composeOverrides',[]))
        stage='https_certificate'
        local=tls_probe('127.0.0.1');public=tls_probe(DOMAIN)
        logs=subprocess.run(['docker','logs','--since','30m','--tail','2000',CADDY],capture_output=True,timeout=20,check=False)
        log_events=certificate_log_events(logs.stdout+logs.stderr) if logs.returncode==0 else []
        stage='https_application'
        html=None
        try:
            with urllib.request.urlopen('http://127.0.0.1:13001/control',timeout=5) as response:
                if response.status==200:html=response.read(1024*1024).decode('utf8')
        except Exception:pass
        asset=None;asset_status={'httpStatus':None}
        if html is not None:
            try:asset=asset_from_html(html);asset_status=http_probe('https://'+DOMAIN+asset)
            except ValueError:pass
        control=http_probe('https://'+DOMAIN+'/control')
        legacy=http_probe('https://'+DOMAIN+'/sportsbook')
        ready=(site_loaded and mounted and configured==loaded and overrides and local['verified'] and public['verified']
               and asset_status['httpStatus']==200 and asset_status.get('contentType') in ('application/javascript','text/javascript'))
        emit(stage='complete',status='ok' if ready else 'https_unverified',readOnly=True,httpsVerified=local['verified'] and public['verified'],
             applicationVerified=ready,siteLoaded=site_loaded,loadedMatchesBoot=configured==loaded,hostMatchesMounted=mounted,
             composeOverridesPreserved=overrides,localTLS=local,publicTLS=public,asset=asset,assetResponse=asset_status,controlResponse=control,
             legacySportsbookResponse=legacy,certificateLogEvents=log_events,logWindowMinutes=30,logTailLines=2000,
             certificateLogsReadable=logs.returncode==0,workerStarted=False,caddyReloaded=False,
             note='Legacy /sportsbook is not the platform iframe route. Control 403 may be the admin CIDR rule. Empty bounded log inspection is not proof of absent issuance. No keys/config/raw logs printed.')
        return 0 if ready else 2
    except Exception:
        emit(stage=stage,status='blocked',readOnly=True,workerStarted=False,caddyReloaded=False,
             note='Inspection failed; no raw exceptions printed. Do not republish the site or start AWS worker.')
        return 2
if __name__=='__main__':raise SystemExit(verification())
