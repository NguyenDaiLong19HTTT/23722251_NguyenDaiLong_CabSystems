#!/usr/bin/env python3
"""Offline static contract checks; does not claim runtime behavior."""
from pathlib import Path
import copy,json,tempfile,subprocess,sys
import grpc_tools,yaml,jsonschema
from google.protobuf import descriptor_pb2
ROOT=Path(__file__).resolve().parents[2]; BASE=ROOT/'contracts'
def read(path):return json.loads(path.read_text())
def validate_event(event, schema, exchange=None, routing_key=None):
 jsonschema.Draft202012Validator(schema,format_checker=jsonschema.FormatChecker()).validate(event)
 source=event['source'].replace('_SERVICE','').lower()
 if exchange is not None and exchange!='cab.'+source+'.events':raise ValueError('source/exchange mismatch')
 kind='notification.v2.' if event['schemaVersion']==2 else 'domain.v1.'
 if routing_key is not None and routing_key!=kind+event['eventType']:raise ValueError('routing mismatch')
 if event['schemaVersion']==1:
  payload=event['payload']; key={'ACCOUNT':'accountId','DRIVER':'driverId','TRIP':'tripId'}[event['aggregateType']]
  if event['aggregateId']!=payload[key]:raise ValueError('aggregate identity mismatch')
  if event['eventType']=='DRIVER_LOCATION_RECORDED':
   from datetime import datetime
   if datetime.fromisoformat(payload['recordedAt'].replace('Z','+00:00'))>datetime.fromisoformat(payload['receivedAt'].replace('Z','+00:00')):raise ValueError('future GPS')
  return
 t=event['eventType']; snap=event['snapshot']
 if t!='DRIVER_ASSIGNED' and event['aggregateId']!=event['referenceId']:raise ValueError('reference mismatch')
 both={'TRIP_COMPLETED','TRIP_CANCELLED','TRIP_ERROR','TRIP_RECOVERED','TRIP_CLOSED_ABNORMALLY','PAYMENT_SUCCESS'}
 if len(event['recipientAccountIds'])!=(2 if t in both else 1):raise ValueError('recipient count')
 allowed=set()
 if t in {'BOOKING_CANCELLED','TRIP_CANCELLED'}:allowed={'reasonCode','reasonText'}
 elif t=='DRIVER_APPLICATION_REJECTED':allowed={'reasonText'}
 elif t=='TRIP_REQUEST_RECEIVED':allowed={'expiresAt'}
 elif t.startswith('PAYMENT_'):allowed={'paymentAttemptId','amount','currency','reasonCode','reasonText'}
 elif t in {'TRIP_ERROR','TRIP_RECOVERED','TRIP_CLOSED_ABNORMALLY'}:allowed={'reasonCode','reasonText'}
 if set(snap)-allowed:raise ValueError('irrelevant snapshot field')
 if t=='BOOKING_CANCELLED' and snap['reasonCode']!='OTHER':raise ValueError('booking cancellation reason')

def main():
 protos=sorted((BASE/'proto').rglob('*.proto'))
 with tempfile.TemporaryDirectory() as temp:
  target=Path(temp)/'cab.pb'
  subprocess.run([sys.executable,'-m','grpc_tools.protoc','-I'+str(BASE/'proto'),'-I'+str(Path(grpc_tools.__file__).parent/'_proto'),'--include_imports','--descriptor_set_out='+str(target),*[str(x) for x in protos]],check=True)
  desc=descriptor_pb2.FileDescriptorSet.FromString(target.read_bytes())
 methods={'/'+f.package+'.'+s.name+'/'+m.name for f in desc.file for s in f.service for m in s.method}
 policy=read(BASE/'rpc-policy.json');assert set(policy['methods'])==methods,'RPC policy coverage drift'
 assert policy['default']=='deny'
 for entry in policy['methods'].values():assert entry['callers'] and 0<entry['deadlineMs']<=4000 and entry['userContext'] in {'none','required'}
 ns=read(BASE/'events/notification-v2.schema.json'); ds=read(BASE/'events/domain-v1.schema.json')
 for schema in [ns,ds]:jsonschema.Draft202012Validator.check_schema(schema)
 # Compare every extracted API06 schema after exact known transformation.
 api=yaml.safe_load((ROOT/'API-Document/06-notification-api.yaml').read_text())
 def normalize(x):
  if isinstance(x,list):return [normalize(v) for v in x]
  if isinstance(x,dict):
   return {k:(v.replace('#/components/schemas/','#/$defs/') if k=='$ref' else normalize(v)) for k,v in x.items() if not(k=='format' and v=='int64')}
  return x
 for name,definition in ns['$defs'].items():assert definition==normalize(api['components']['schemas'][name]),'API06 schema drift: '+name
 fixtures={}
 topology=read(BASE/'events/topology.json')
 for f in sorted((BASE/'events/examples').glob('*.json')):
  e=read(f);fixtures[e['eventType']]=e;key=('notification.v2.' if e['schemaVersion']==2 else 'domain.v1.')+e['eventType'];source=e['source'].replace('_SERVICE','').lower()+'-service';publisher=topology['producers'][source]
  assert key in publisher['routingKeys'];validate_event(e,ns if e['schemaVersion']==2 else ds,publisher['exchange'],key)
 expected={x['properties']['eventType']['enum'][0] for x in ns['$defs']['NotificationDomainEvent']['oneOf']}|{x['properties']['eventType']['const'] for x in ds['oneOf']}
 assert set(fixtures)==expected
 negatives=[]
 def bad(name,mutator):
  e=copy.deepcopy(fixtures[name]);mutator(e);negatives.append(e)
 bad('PAYMENT_SUCCESS',lambda e:e['snapshot'].pop('amount'))
 bad('PAYMENT_SUCCESS',lambda e:e['snapshot'].pop('paymentAttemptId'))
 bad('PAYMENT_FAILED',lambda e:e['snapshot'].pop('paymentAttemptId'))
 bad('BOOKING_RECEIVED',lambda e:e.update(source='TRIP_SERVICE'))
 bad('BOOKING_RECEIVED',lambda e:e.update(schemaVersion=1))
 bad('BOOKING_RECEIVED',lambda e:e.update(recipientAccountIds=[]))
 bad('BOOKING_RECEIVED',lambda e:e.update(recipientAccountIds=['ACC001','ACC001']))
 bad('BOOKING_RECEIVED',lambda e:e.update(referenceId='OTHER'))
 bad('BOOKING_RECEIVED',lambda e:e['snapshot'].update(paymentAttemptId='ATT'))
 bad('BOOKING_CANCELLED',lambda e:e['snapshot'].update(reasonCode='NO_SHOW'))
 bad('TRIP_COMPLETED',lambda e:e.update(recipientAccountIds=['ACC001']))
 bad('TRIP_REQUEST_RECEIVED',lambda e:e['snapshot'].pop('expiresAt'))
 bad('DRIVER_APPLICATION_REJECTED',lambda e:e['snapshot'].pop('reasonText'))
 bad('JOURNEY_METRICS_CONFIRMED',lambda e:e['payload'].update(metricsVersion=0))
 bad('JOURNEY_METRICS_CONFIRMED',lambda e:e['payload'].update(amount=50000))
 bad('DRIVER_LOCATION_RECORDED',lambda e:e['payload'].update(recordedAt='2026-10-02T00:00:00Z'))
 bad('DRIVER_LOCATION_RECORDED',lambda e:e['payload'].update(tripId='client-choice'))
 bad('ACCOUNT_ACCESS_CHANGED',lambda e:e.update(aggregateId='WRONG'))
 bad('ACCOUNT_ACCESS_CHANGED',lambda e:e.update(eventId='not-uuid'))
 for e in negatives:
  try:validate_event(e,ns if e['schemaVersion']==2 else ds)
  except (jsonschema.ValidationError,ValueError,KeyError):pass
  else:raise AssertionError('accepted invalid event '+str(e))
 for exchange,key in [('cab.trip.events','notification.v2.BOOKING_RECEIVED'),('cab.booking.events','notification.v2.TRIP_COMPLETED')]:
  try:validate_event(fixtures['BOOKING_RECEIVED'],ns,exchange,key)
  except ValueError:pass
  else:raise AssertionError('accepted routing/source spoof')
 for f in (ROOT/'API-Document').glob('*.yaml'):yaml.safe_load(f.read_text())
 print(f'PASS: {len(protos)} protobuf files compiled; {len(methods)} RPCs have exact policy coverage; 2 schemas; {len(fixtures)} valid event fixtures; {len(negatives)+2} negative checks; API06 schema parity; all OpenAPI YAML parse.')
if __name__=='__main__':main()
