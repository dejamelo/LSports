#!/usr/bin/env python3
"""Read-only AWS control-plane/Price List query. Run in AWS CloudShell; no credentials printed."""
import datetime
import decimal
import json
import subprocess

REGION='us-east-2'
PUBLIC_IP='77.113.150.100'
PROPOSED='m7i.xlarge'
D=decimal.Decimal

def emit(**v): print(json.dumps(v),flush=True)
def aws(service,operation,*args,region=REGION):
    try:
        result=subprocess.run(['aws',service,operation,'--region',region,'--output','json','--no-cli-pager',*args],capture_output=True,timeout=60,check=False)
    except (OSError,subprocess.TimeoutExpired):
        emit(stage=service+'.'+operation,status='unavailable',reason='cli_missing_or_timeout'); return None
    if result.returncode:
        # No raw stderr, account credentials, tokens or CLI debug output.
        error=result.stderr.decode(errors='replace').lower()
        reason='access_denied' if 'accessdenied' in error or 'unauthorizedoperation' in error else 'aws_request_failed'
        emit(stage=service+'.'+operation,status='unavailable',reason=reason,exitCode=result.returncode); return None
    try: return json.loads(result.stdout)
    except ValueError:
        emit(stage=service+'.'+operation,status='unavailable',reason='invalid_json'); return None

def price(service,filters):
    f=[{'Type':'TERM_MATCH','Field':k,'Value':v} for k,v in filters.items()]
    result=aws('pricing','get-products','--service-code',service,'--filters',json.dumps(f),'--max-results','100','--no-paginate',region='us-east-1')
    if not result or result.get('NextToken'): return None
    prices=[]
    for raw in result.get('PriceList',[]):
        item=json.loads(raw)
        for term in item.get('terms',{}).get('OnDemand',{}).values():
            for dim in term.get('priceDimensions',{}).values():
                prices.append({'usd':dim.get('pricePerUnit',{}).get('USD'),'unit':dim.get('unit'),
                               'beginRange':dim.get('beginRange'),'endRange':dim.get('endRange'),
                               'effectiveDate':term.get('effectiveDate'),'sku':item.get('product',{}).get('sku')})
    emit(stage='official_price',source='AWS Price List API',service=service,filters=filters,prices=prices,status='ok' if prices else 'not_found')
    # Only use an unambiguous, flat price. Never assume missing query data is zero.
    if len(prices)!=1 or prices[0]['usd'] is None or prices[0]['beginRange']!='0' or prices[0]['endRange']!='Inf': return None
    return prices[0]

def preserved_ip(addresses,instance):
    enis={n['NetworkInterfaceId'] for n in instance.get('NetworkInterfaces',[])}
    matches=[a for a in addresses if a.get('PublicIp')==PUBLIC_IP and a.get('AllocationId') and a.get('AssociationId') and a.get('NetworkInterfaceId') in enis]
    return bool(matches)

def main():
    emit(stage='start',readOnly=True,capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),region=REGION)
    data=aws('ec2','describe-instances','--filters','Name=ip-address,Values='+PUBLIC_IP)
    if data is None: return 2
    instances=[i for r in data.get('Reservations',[]) for i in r.get('Instances',[])]
    if len(instances)!=1:
        emit(stage='instance',status='unverified',matches=len(instances),note='Wrong account/region or public IP changed; do not guess an instance ID.'); return 2
    instance=instances[0]
    instance_id=instance['InstanceId']
    current=instance['InstanceType']
    emit(stage='instance',id=instance_id,type=current,az=instance.get('Placement',{}).get('AvailabilityZone'),
         rootDeviceType=instance.get('RootDeviceType'),architecture=instance.get('Architecture'),
         platform=instance.get('PlatformDetails'),state=instance.get('State',{}).get('Name'))
    addresses=aws('ec2','describe-addresses','--filters','Name=public-ip,Values='+PUBLIC_IP)
    eip=preserved_ip(addresses.get('Addresses',[]),instance) if addresses is not None else None
    emit(stage='public_ip',ip=PUBLIC_IP,elasticIpAssociated=eip,
         stopStartPreservation='expected_if_association_retained' if eip else 'not_confirmed' if eip is None else 'not_preserved_as_fixed_address',
         note='No allocation/association performed. Auto-assigned public IP/DNS can change on stop/start. Private IP normally persists.')
    offering=aws('ec2','describe-instance-type-offerings','--location-type','availability-zone','--filters',
                 'Name=location,Values='+instance.get('Placement',{}).get('AvailabilityZone','us-east-2c'), 'Name=instance-type,Values='+PROPOSED)
    emit(stage='offering',instanceType=PROPOSED,offeredInAz=bool(offering.get('InstanceTypeOfferings')) if offering is not None else None,
         note='An offering does not guarantee immediate capacity.')
    rates={}
    for kind in (current,PROPOSED):
        p=price('AmazonEC2',{'regionCode':REGION,'instanceType':kind,'operatingSystem':'Linux','tenancy':'Shared','preInstalledSw':'NA','capacitystatus':'Used','productFamily':'Compute Instance'})
        if p and p['unit']=='Hrs': rates[kind]=D(p['usd'])*730
    volume_ids=[b['Ebs']['VolumeId'] for b in instance.get('BlockDeviceMappings',[]) if 'Ebs' in b]
    volumes=aws('ec2','describe-volumes','--volume-ids',*volume_ids) if volume_ids else None
    emit(stage='volumes',items=[{k:v.get(k) for k in ('VolumeId','VolumeType','Size','Iops','Throughput','Encrypted')} for v in (volumes or {}).get('Volumes',[])],
         note='No snapshot or volume changes. Snapshot retention/transfer costs require billing inventory.')
    storage=None
    vs=(volumes or {}).get('Volumes',[])
    if vs and len(vs)==len(volume_ids) and all(v.get('VolumeType')=='gp3' and v.get('Iops',0)<=3000 and v.get('Throughput',0)<=125 for v in vs):
        p=price('AmazonEC2',{'regionCode':REGION,'usagetype':'USE2-EBS:VolumeUsage.gp3'})
        if p and p['unit']=='GB-Mo': storage=D(p['usd'])*sum(v['Size'] for v in vs)
    # Enumerate public IPv4 addresses attached to this instance, not an assumed count.
    ips={p['Association']['PublicIp'] for n in instance.get('NetworkInterfaces',[]) for p in n.get('PrivateIpAddresses',[]) if p.get('Association',{}).get('PublicIp')}
    ipcost=None
    if ips:
        p=price('AmazonVPC',{'regionCode':REGION,'usagetype':'USE2-PublicIPv4:InUseAddress'})
        if p and p['unit']=='Hrs': ipcost=D(p['usd'])*730*len(ips)
    if current in rates and PROPOSED in rates:
        emit(stage='compute_budget',hours=730,currency='USD',currentMonthly=str(rates[current]),proposedMonthly=str(rates[PROPOSED]),deltaMonthly=str(rates[PROPOSED]-rates[current]),
             basis='Linux Shared On-Demand; no credits, reservations or Savings Plans')
        if storage is not None and ipcost is not None:
            emit(stage='monthly_subtotal',currency='USD',current=str(rates[current]+storage+ipcost),proposed=str(rates[PROPOSED]+storage+ipcost),
                 storage=str(storage),publicIPv4=str(ipcost),excludes='Snapshots/backups, traffic, other services, taxes and commitments; not the entire AWS bill')
    emit(stage='complete',readOnly=True,noResourceChanges=True,pricingComplete=current in rates and PROPOSED in rates,
         note='Review outputs and missing components before approving value/window. No stop/modify/start calls.')
    return 0

if __name__=='__main__':
    try: raise SystemExit(main())
    except Exception:
        emit(stage='collector',status='failed',reason='unexpected_response_sanitized',readOnly=True)
        raise SystemExit(2)
