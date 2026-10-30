import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { createClient, readTlsFromEnvironment, serviceDefinition, unaryCall } from '@cab/grpc-transport';

const root=fileURLToPath(new URL('../',import.meta.url));
const pki=join(root,'.secrets','customer-dev','pki');
process.env.IDENTITY_SERVICE_CA_FILE=join(pki,'ca.crt');
process.env.IDENTITY_SERVICE_CERT_FILE=join(pki,'identity.crt');
process.env.IDENTITY_SERVICE_KEY_FILE=join(pki,'identity.key');
const client=createClient('127.0.0.1:50062',readTlsFromEnvironment('IDENTITY_SERVICE'),'customer-service');
const definition=serviceDefinition('cab.internal.v1.CustomerInternalService',
  'proto/cab/internal/v1/customer.proto');
const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
const call=(method,request)=>unaryCall(client,definition,method,request,metadata,2000);
const command=(id,operation)=>({command_id:id,operation_id:operation});
const expectedCode=async(promise,code)=>{
  try {await promise;assert.fail('Expected gRPC rejection');}
  catch(error) {if (error.code==='ERR_ASSERTION') throw error;assert.equal(error.code,code);}
};
try {
  const operation=randomUUID(),account=randomUUID(),customer=randomUUID(),cmd=randomUUID();
  const request={command:command(cmd,operation),account_id:account,customer_id:customer};
  const first=await call('ProvisionCustomer',request);
  assert.deepEqual(first,{operation_id:operation,account_id:account,customer_id:customer,state:'PROVISIONED'});
  assert.deepEqual(await call('ProvisionCustomer',request),first);
  await expectedCode(call('ProvisionCustomer',{...request,customer_id:randomUUID()}),grpc.status.ALREADY_EXISTS);
  await expectedCode(call('ProvisionCustomer',{...request,command:command(randomUUID(),operation)}),
    grpc.status.ALREADY_EXISTS);
  assert.deepEqual(await call('GetCustomerProvision',{id:operation}),first);
  const cancel={command:command(randomUUID(),operation),account_id:account,profile_id:customer};
  const cancelled=await call('CancelCustomerProvision',cancel);
  assert.equal(cancelled.state,'PROVISION_CANCELLED');
  assert.deepEqual(await call('CancelCustomerProvision',cancel),cancelled);
  assert.deepEqual(await call('GetCustomerProvision',{id:operation}),cancelled);
  await expectedCode(call('ProvisionCustomer',{...request,command:command(randomUUID(),operation)}),
    grpc.status.ALREADY_EXISTS);
  const lateOperation=randomUUID(),lateAccount=randomUUID(),lateCustomer=randomUUID();
  const before={command:command(randomUUID(),lateOperation),account_id:lateAccount,profile_id:lateCustomer};
  assert.equal((await call('CancelCustomerProvision',before)).state,'PROVISION_CANCELLED');
  await expectedCode(call('ProvisionCustomer',{command:command(randomUUID(),lateOperation),
    account_id:lateAccount,customer_id:lateCustomer}),grpc.status.ALREADY_EXISTS);
  console.info('PASS real Customer gRPC receipt replay/conflict/tombstone/Cancel-before-Provision over mTLS');
} finally {client.close();}
