// Public GETs only. No cookies, passwords, token URLs, logins or betting requests.
import { pathToFileURL } from 'node:url';
const HOSTS=new Set(['www.loteriaargentina.lat','demo.loteriaargentina.lat','loteriaargentina.lat']);
const MAX=512*1024;
function permitted(url){return url.protocol==='https:' && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port==='443');}
async function get(url,fetcher){
  const response=await fetcher(url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(20000),headers:{'User-Agent':'ADL-POSNET-readonly-validation'}});
  let text='';
  if(response.body){
    const reader=response.body.getReader();const chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;const part=value.subarray(0,Math.max(0,MAX-size));chunks.push(part);size+=part.length;if(size>=MAX)break;}}
    finally{await reader.cancel();}
    text=Buffer.concat(chunks).toString('utf8');
  }
  return {response,text};
}
export async function inspectPage(start,fetcher=fetch){
  let url=new URL(start),redirects=0;
  const origin=url.origin;
  try{
    if(!permitted(url))throw Error('unexpected_origin');
    let result;
    while(true){
      result=await get(url,fetcher);
      if(![301,302,303,307,308].includes(result.response.status))break;
      if(++redirects>5)return {origin,status:'failed',reason:'redirect_limit'};
      const location=result.response.headers.get('location');
      if(!location)return {origin,status:'failed',reason:'missing_redirect_location'};
      const next=new URL(location,url);
      if(!permitted(next))return {origin,status:'requires_manual_validation',reason:'external_or_credentialed_redirect_not_followed',redirects};
      url=next;
    }
    const contentType=(result.response.headers.get('content-type')||'').split(';')[0];
    const html=result.response.status===200 && contentType.toLowerCase()==='text/html' && /<(?:html|!doctype)/i.test(result.text);
    const assets=[];
    for(const [kind,re] of [['javascript',/<script\b[^>]*\bsrc\s*=\s*["']([^"'<>]+)["']/ig],['stylesheet',/<link\b[^>]*\bhref\s*=\s*["']([^"'<>]+\.css(?:\?[^"'<>]*)?)["']/ig]]){
      let match,target;
      while((match=re.exec(result.text))){const candidate=new URL(match[1],url);if(permitted(candidate) && candidate.origin===url.origin){target=candidate;break;}}
      if(!target)continue;
      const file=await get(target,fetcher);
      const type=(file.response.headers.get('content-type')||'').split(';')[0].toLowerCase();
      assets.push({kind,httpStatus:file.response.status,contentType:type,ok:file.response.status===200 && (kind==='stylesheet'?type==='text/css':['application/javascript','text/javascript','application/ecmascript','text/ecmascript'].includes(type))});
    }
    return {origin,status:html && assets.every(a=>a.ok)?'ok':'failed',httpStatus:result.response.status,contentType,htmlDetected:html,redirects,assets,
            assetCoverage:assets.length?'sample_only':'no_same_origin_assets_detected',sso:'not_authenticated_by_this_check'};
  }catch(error){
    const code=error?.cause?.code;
    const safe=['ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID'];
    return {origin,status:'failed',reason:safe.includes(code)?code:'network_timeout_or_response_error_sanitized'};
  }
}
export async function main(){
  let failed=false;
  for(const host of ['www.loteriaargentina.lat','demo.loteriaargentina.lat']){
    const result=await inspectPage('https://'+host+'/');
    console.log(JSON.stringify({stage:'public_page',readOnly:true,...result}));
    if(result.status!=='ok')failed=true;
  }
  console.log(JSON.stringify({stage:'coverage',publicHttpOnly:true,authenticatedSsoValidated:false,noFinancialRequests:true,
    next:'Validate normal SSO entry in browser; do not share passwords, tokens, cookies or full login URLs.'}));
  if(failed)process.exitCode=2;
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url)main();
