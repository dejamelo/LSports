import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('resize',Path(__file__).with_name('diagnose-aws-resize.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class ResizeTest(unittest.TestCase):
    def test_eip_requires_association_with_correct_interface(self):
        instance={'NetworkInterfaces':[{'NetworkInterfaceId':'eni-current'}]}
        good={'PublicIp':m.PUBLIC_IP,'AllocationId':'eipalloc-test','AssociationId':'eipassoc-test','NetworkInterfaceId':'eni-current'}
        self.assertTrue(m.preserved_ip([good],instance))
        self.assertFalse(m.preserved_ip([dict(good,NetworkInterfaceId='eni-other')],instance))
        self.assertFalse(m.preserved_ip([dict(good,AssociationId=None)],instance))
        self.assertFalse(m.preserved_ip([],instance))

    def test_price_requires_single_unpaginated_rate(self):
        with patch.object(m,'aws',return_value={'NextToken':'PRIVATE','PriceList':[]}):
            self.assertIsNone(m.price('AmazonEC2',{}))

    def test_main_uses_only_read_apis_and_exact_costs(self):
        calls=[]
        def aws(service,op,*args,**kwargs):
            calls.append((service,op))
            if op=='describe-instances': return {'Reservations':[{'Instances':[{'InstanceId':'i-test','InstanceType':'c7i-flex.large','Placement':{'AvailabilityZone':'us-east-2c'},'NetworkInterfaces':[{'NetworkInterfaceId':'eni-test','PrivateIpAddresses':[{'Association':{'PublicIp':m.PUBLIC_IP}}]}],'BlockDeviceMappings':[{'Ebs':{'VolumeId':'vol-test'}}]}]}]}
            if op=='describe-addresses': return {'Addresses':[]}
            if op=='describe-instance-type-offerings': return {'InstanceTypeOfferings':[{}]}
            if op=='describe-volumes': return {'Volumes':[{'VolumeId':'vol-test','VolumeType':'gp3','Size':40,'Iops':3000,'Throughput':125}]}
            self.fail('Unexpected operation '+op)
        def price(service,filters):
            if 'instanceType' in filters: return {'usd':'0.2016' if filters['instanceType']=='m7i.xlarge' else '0.0848','unit':'Hrs'}
            return {'usd':'0.08','unit':'GB-Mo'} if service=='AmazonEC2' else {'usd':'0.005','unit':'Hrs'}
        out=io.StringIO()
        with patch.object(m,'aws',side_effect=aws),patch.object(m,'price',side_effect=price),contextlib.redirect_stdout(out):
            self.assertEqual(m.main(),0)
        rows=[json.loads(s) for s in out.getvalue().splitlines()]
        budget=next(r for r in rows if r['stage']=='compute_budget')
        self.assertEqual(m.D(budget['deltaMonthly']),m.D('85.2640'))
        total=next(r for r in rows if r['stage']=='monthly_subtotal')
        self.assertEqual(m.D(total['proposed']),m.D('154.0180'))
        self.assertTrue(all(op.startswith('describe-') for _,op in calls))

if __name__=='__main__': unittest.main()
