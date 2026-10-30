import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as grpc from '@grpc/grpc-js';
import {createClient,decodeFacadeError,serviceDefinition,unaryCall} from '@cab/grpc-transport';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=join(root,'.secrets','customer-dev','pki');
const tls={ca:readFileSync(join(dir,'ca.crt')),cert:readFileSync(join(dir,'gateway.crt')),
  key:readFileSync(join(dir,'gateway.key'))};
const client=createClient('127.0.0.1:50261',tls,'identity-service');
const definition=serviceDefinition('cab.gateway.v1.IdentityDriverRegistrationFacadeService',
  'proto/cab/gateway/v1/driver_registration_facade.proto');
try {
  const value=await unaryCall(client,definition,'RequestDriverOtp',
    {phone:'09'+String(Math.floor(Math.random()*1e8)).padStart(8,'0')},new grpc.Metadata(),2500);
  console.info('gRPC OTP request accepted',Boolean(value));
} catch(error) {
  console.info('gRPC OTP failure code/reason',error.code,decodeFacadeError(error)?.reason);
} finally {client.close();}
