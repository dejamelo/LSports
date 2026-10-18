#!/usr/bin/env bash
# Streamable read-only collector. No writes, restarts, installs or permission changes.
set -u
if ! command -v python3 >/dev/null; then
  printf 'collector=failed stage=prerequisite reason=python3_missing; no installation attempted\n'
  exit 2
fi
exec python3 - <<'PY'
import datetime
import json
import re
import shutil
import subprocess


def emit(**fields):
    print(json.dumps(fields, ensure_ascii=False), flush=True)


def run(args, stage, subject=None, timeout=20):
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        emit(stage=stage, subject=subject, status='failed', reason='timeout' if isinstance(exc, subprocess.TimeoutExpired) else 'command_unavailable')
        return None
    if p.returncode:
        # Never print exceptions, argv, raw stderr, URLs, headers or daemon replies.
        error = p.stderr.decode(errors='replace').lower()
        reason = 'aws_access_denied' if 'accessdenied' in error else 'aws_credentials_unavailable' if any(s in error for s in ('unable to locate credentials', 'expiredtoken', 'invalidclienttokenid')) else 'permission_denied' if 'permission denied' in error else 'template_error' if any(s in error for s in ('template', 'index of untyped nil', "can't evaluate field")) else 'daemon_unreachable' if any(s in error for s in ('cannot connect', 'connection refused')) else 'command_failed'
        emit(stage=stage, subject=subject, status='failed', exitCode=p.returncode, reason=reason)
        return None
    return p.stdout


def parse(data, stage, subject=None):
    if data is None:
        return None
    try:
        return json.loads(data)
    except (ValueError, TypeError):
        emit(stage=stage, subject=subject, status='failed', reason='invalid_json')
        return None


def limits(item):
    host = item.get('HostConfig') or {}
    state = item.get('State') or {}
    config = item.get('Config') or {}
    log = host.get('LogConfig') or {}
    opts = log.get('Config') or {}  # Missing/null logging options must not abort Caddy inventory.
    labels = config.get('Labels') or {}
    return dict(
        stage='container.inspect', status='ok', id=item.get('Id'), name=item.get('Name'),
        running=state.get('Running'), oomKilled=state.get('OOMKilled'),
        restarts=item.get('RestartCount'), health=(state.get('Health') or {}).get('Status'),
        limits={k: host.get(k) for k in ('Memory', 'MemoryReservation', 'MemorySwap', 'NanoCpus', 'CpuQuota', 'CpuPeriod', 'CpuShares', 'CpusetCpus', 'PidsLimit')},
        restartPolicy=(host.get('RestartPolicy') or {}).get('Name'),
        log={'driver': log.get('Type'), 'maxSize': opts.get('max-size'), 'maxFile': opts.get('max-file')},
        compose={k: labels.get('com.docker.compose.' + k) for k in ('project', 'service', 'project.config_files', 'project.working_dir')},
        mounts=[{'type': m.get('Type'), 'source': m.get('Source'), 'destination': m.get('Destination'), 'rw': m.get('RW')} for m in item.get('Mounts', [])],
        ports=(item.get('NetworkSettings') or {}).get('Ports'),
        networks={k: {'ip': v.get('IPAddress'), 'aliases': v.get('Aliases')} for k,v in ((item.get('NetworkSettings') or {}).get('Networks') or {}).items()})


def safe_dial(value):
    # Static host/IP/port or unix socket only. Do not expose credentials or query strings.
    if not isinstance(value, str):
        return '[dynamic_or_unavailable]'
    if re.fullmatch(r'[a-zA-Z0-9_.:\[\]-]+', value):
        return value
    return '[redacted_or_dynamic]'


def routes(config, inventory, subject):
    count = 0
    source = next((i for i in inventory if i.get('Name') == subject), {})
    source_networks = set(((source.get('NetworkSettings') or {}).get('Networks') or {}).keys())
    servers = (((config.get('apps') or {}).get('http') or {}).get('servers') or {})
    def walk(nodes, matches, server):
        nonlocal count
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            own = []
            for match in node.get('match') or []:
                own.append({k: match[k] for k in ('host', 'path', 'method') if k in match})
            context = matches + own
            if node.get('handler') == 'reverse_proxy':
                upstreams = [safe_dial(u.get('dial')) for u in node.get('upstreams') or []]
                candidates = []
                for item in inventory:
                    net = item.get('NetworkSettings') or {}
                    names = {(item.get('Name') or '').lstrip('/')}
                    for v in (net.get('Networks') or {}).values():
                        names.add(v.get('IPAddress'))
                        names.update(v.get('Aliases') or [])
                    for upstream in upstreams:
                        hostname, _, port = upstream.rpartition(':')
                        if hostname in names:
                            candidates.append({'container': item.get('Name'), 'upstream': upstream, 'evidence': 'container_name_alias_or_ip', 'sharedNetworks': sorted(source_networks.intersection((net.get('Networks') or {}).keys()))})
                        for target, bindings in (net.get('Ports') or {}).items():
                            if any(port == b.get('HostPort') and hostname in ('127.0.0.1','localhost','host.docker.internal') for b in bindings or []):
                                candidates.append({'container': item.get('Name'), 'upstream': upstream, 'containerPort': target, 'evidence': 'published_port_candidate_only', 'requiresNetworkNamespaceVerification': True})
                emit(stage='caddy.route', caddy=subject, server=server, match=context,
                     upstreams=upstreams, dynamicUpstreams=bool(node.get('dynamic_upstreams')), candidates=candidates)
                count += 1
            walk(node.get('routes'), context, server)
            walk(node.get('handle'), context, server)
    for name, server in servers.items():
        walk(server.get('routes'), [], name)
    emit(stage='caddy.routes.summary', caddy=subject, reverseProxyRoutes=count,
         note='Active admin configuration only; candidates need network/path verification. No application requests sent.')


def boot_inventory():
    raw = run(['systemctl','list-unit-files','--type=service','--state=enabled','--no-legend','--no-pager'], 'boot.units')
    if raw is None:
        return
    units = [line.split()[0] for line in raw.decode(errors='replace').splitlines() if line.split()]
    for unit in units:
        # Inspect every enabled service, not only units named POSNET; never output ExecStart arguments.
        if not re.fullmatch(r'[a-zA-Z0-9_.@:\\-]+\.service', unit):
            continue
        raw = run(['systemctl','show',unit,'--no-pager','-p','Id','-p','ActiveState','-p','UnitFileState','-p','After','-p','Requires','-p','ExecStart'], 'boot.unit', unit)
        if raw is None:
            continue
        props = dict(line.split('=',1) for line in raw.decode(errors='replace').splitlines() if '=' in line)
        command = props.pop('ExecStart','')
        executables = [p.rsplit('/',1)[-1] for p in re.findall(r'(?:^|[ {;])path=([^ ;}]+)', command)]
        emit(stage='boot.unit', unit=unit, properties=props, executables=executables,
             mentionsDocker='docker' in command.lower(), mentionsCompose='compose' in command.lower(),
             note='Arguments omitted. An enabled unit alone does not prove it restores every container.')
    emit(stage='boot.coverage', status='partial_until_operator_review',
         note='Inspect approved startup automation privately: systemd dependencies, root/user cron, rc.local, cloud-init and rootless Docker. No script bodies or cron commands dumped; no boot test performed.')


def pricing():
    if not shutil.which('aws'):
        emit(stage='pricing', status='unavailable', reason='aws_cli_missing', action='No install. Confirm with AWS Pricing Calculator for Ohio.')
        return
    for instance in ('c7i-flex.large','m7i.large','m7i.xlarge'):
        filters = [{'Type':'TERM_MATCH','Field':k,'Value':v} for k,v in {
            'regionCode':'us-east-2', 'instanceType':instance, 'operatingSystem':'Linux',
            'tenancy':'Shared', 'preInstalledSw':'NA', 'capacitystatus':'Used',
            'productFamily':'Compute Instance'}.items()]
        raw = run(['aws','pricing','get-products','--region','us-east-1','--service-code','AmazonEC2',
                   '--filters',json.dumps(filters),'--max-results','100','--no-paginate','--output','json','--no-cli-pager'], 'pricing.query', instance, timeout=30)
        data = parse(raw,'pricing.parse',instance)
        if data is None:
            continue
        prices = []
        for entry in data.get('PriceList',[]):
            product = parse(entry, 'pricing.product', instance)
            if not product:
                continue
            for term in (product.get('terms') or {}).get('OnDemand',{}).values():
                for dimension in term.get('priceDimensions',{}).values():
                    if dimension.get('unit') == 'Hrs':
                        prices.append({'usdPerHour':dimension.get('pricePerUnit',{}).get('USD'), 'effectiveDate':term.get('effectiveDate'), 'sku':product.get('product',{}).get('sku')})
        emit(stage='pricing.result', source='AWS Price List API', instance=instance, region='us-east-2',
             status='ok' if prices and not data.get('NextToken') else 'incomplete', onDemand=prices,
             excludes='EBS, IPv4, transfer, backups, taxes, discounts and credits')


def main():
    emit(stage='collector.start', readOnly=True, capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    if not shutil.which('docker'):
        emit(stage='prerequisite', status='failed', reason='docker_cli_missing')
        return 2
    memory = run(['free','-b'],'host.memory')
    if memory:
        for line in memory.decode(errors='replace').splitlines():
            parts = line.split()
            if parts and parts[0] == 'Mem:' and len(parts) >= 7 and all(v.isdigit() for v in parts[1:7]):
                emit(stage='host.memory', totalBytes=int(parts[1]), availableBytes=int(parts[6]))
    server = parse(run(['docker','info','--format','{{json .}}'],'docker.info'),'docker.info.parse')
    if not server:
        return 2
    emit(stage='docker.info', **{k:server.get(k) for k in ('ServerVersion','NCPU','MemTotal','CgroupVersion','CgroupDriver')})
    raw = run(['docker','ps','-aq'],'container.list')
    if raw is None:
        return 2
    inventory = []
    failures = 0
    for cid in raw.decode().split():
        if not re.fullmatch('[a-f0-9]{12,64}',cid):
            emit(stage='container.list', status='failed', reason='invalid_id'); failures += 1; continue
        # Raw inspect is private in-memory input only: never written or printed.
        parsed = parse(run(['docker','inspect',cid],'container.inspect',cid),'container.parse',cid)
        if not isinstance(parsed,list) or len(parsed) != 1 or not isinstance(parsed[0],dict):
            failures += 1
            continue
        item = parsed[0]
        try:
            emit(**limits(item)); inventory.append(item)
        except (TypeError, AttributeError, KeyError):
            emit(stage='container.fields', subject=cid, status='failed', reason='unexpected_field_shape')
            failures += 1
    stats = run(['docker','stats','--no-stream','--format','{{json .}}'],'container.stats',timeout=30)
    if stats:
        for line in stats.splitlines():
            data = parse(line,'container.stats.parse')
            if isinstance(data,dict):
                emit(stage='container.stats', **{k:data.get(k) for k in ('Name','CPUPerc','MemUsage','MemPerc','PIDs')})
    for item in inventory:
        image = ((item.get('Config') or {}).get('Image') or '').split('/')[-1]
        # Image identifies candidates, not production ownership; never delete based on name.
        if not image.startswith('caddy:') or not (item.get('State') or {}).get('Running'):
            continue
        cid = item['Id']
        config = parse(run(['docker','exec',cid,'wget','-qO-','-T','5','http://127.0.0.1:2019/config/'], 'caddy.active_config',cid),'caddy.parse',cid)
        if isinstance(config,dict):
            routes(config,inventory,item.get('Name'))
        else:
            emit(stage='caddy.coverage', subject=cid, status='unverified', reason='default_admin_endpoint_unavailable', note='No config reload; mounted files are not proof of active configuration.')
    boot_inventory()
    pricing()
    emit(stage='collector.summary', containersInspected=len(inventory), inspectionFailures=failures,
         status='partial' if failures else 'container_inventory_complete',
         noServicesChanged=True, note='No restart/start/stop/update/prune. Route/boot/pricing coverage must be checked independently.')
    return 2 if failures else 0

if __name__ == '__main__':
    raise SystemExit(main())
PY
