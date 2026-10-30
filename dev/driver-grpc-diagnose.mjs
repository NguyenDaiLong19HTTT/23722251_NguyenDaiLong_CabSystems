import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createClient,serviceDefinition,unaryCall,decodeFacadeError } from '@cab/grpc-transport';
const root=fileURLToPath(new URL('../',import.meta.url)),folder=join(root,'.secrets','customer-dev');
const data=JSON.parse(readFileSync(join(folder,'driver_seed.json'),'utf8'));
const password=readFileSync(join(folder,'driver_demo_password'),'utf8').trim();
const base='http://127.0.0.1:33101';
const login=await fetch(base+'/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:data.email,password})}).then(x=>x.json());
const profile=await fetch(base+'/v1/drivers/me',{headers:{Authorization:'Bearer '+login.accessToken}}).then(x=>x.json());
const tls={ca:readFileSync(join(folder,'pki','ca.crt')),
  cert:readFileSync(join(folder,'pki','gateway.crt')),key:readFileSync(join(folder,'pki','gateway.key'))};
const client=createClient('127.0.0.1:50163',tls,'driver-service');
const def=serviceDefinition('cab.gateway.v1.DriverFacadeService','proto/cab/gateway/v1/driver_facade.proto');
const meta=new grpc.Metadata();meta.set('x-correlation-id',randomUUID());
meta.set('x-cab-user-authorization','Bearer '+login.accessToken);
meta.set('x-cab-idempotency-key',randomUUID());
try {
  const value=await unaryCall(client,def,'SetMyDriverAvailability',
    {expected_version:String(profile.driver.version),driver_status:'AVAILABLE'},meta,3000);
  console.info('gRPC Driver availability accepted:',value?.driver_status);
} catch(error) {
  console.info('gRPC Driver availability:',{code:error.code,
    facadeReason:decodeFacadeError(error)?.reason});
} finally {client.close();}
