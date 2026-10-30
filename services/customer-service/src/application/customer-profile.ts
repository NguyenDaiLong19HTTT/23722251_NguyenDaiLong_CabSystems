import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createClient, facadeError, readTlsFromEnvironment, serviceDefinition, unaryCall } from '@cab/grpc-transport';
import type { PrismaClient } from '../infrastructure/prisma/generated/client.js';

type Data=Record<string,unknown>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validTimestamp(value:unknown):boolean {
  if (typeof value!=='object' || value===null || Array.isArray(value)) return false;
  const {seconds,nanos}=value as Data;
  if (typeof seconds!=='string' || !/^\d+$/.test(seconds) ||
      typeof nanos!=='number' || !Number.isInteger(nanos) || nanos<0 || nanos>=1e9)
    return false;
  const epochSeconds=Number(seconds);
  return Number.isSafeInteger(epochSeconds) &&
    Number.isFinite(new Date(epochSeconds*1000+Math.floor(nanos/1e6)).getTime());
}
export function mapCustomerProfile(accountId:string,customerId:string,contact:Data):Data {
  if (contact.account_id!==accountId || typeof contact.full_name!=='string' ||
      typeof contact.email!=='string' || typeof contact.phone!=='string' ||
      !['ACTIVE','INACTIVE','SUSPENDED'].includes(String(contact.account_status)) ||
      !validTimestamp(contact.created_at) || !validTimestamp(contact.updated_at))
    throw facadeError(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
  return {account_id:accountId,customer_id:customerId,
    full_name:contact.full_name,email:contact.email,phone:contact.phone,role:'CUSTOMER',
    account_status:contact.account_status,created_at:contact.created_at,
    updated_at:contact.updated_at};
}
export class CustomerProfileService {
  private readonly client:grpc.Client;
  private readonly identity=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  constructor(private readonly db:PrismaClient) {
    const target=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    if (!target) throw new Error('Identity gRPC target is missing');
    this.client=createClient(target,readTlsFromEnvironment('CUSTOMER_SERVICE'),'identity-service');
  }
  close():void {this.client.close();}
  async get(request:unknown,incoming:grpc.Metadata):Promise<Data> {
    const customerId=(request as Data)?.customer_id;
    if (typeof customerId!=='string' || !customerId)
      throw facadeError(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    if (!uuid.test(customerId)) throw facadeError(grpc.status.NOT_FOUND,'CUSTOMER_NOT_FOUND');
    const user=incoming.get('x-cab-user-authorization')[0];
    if (typeof user!=='string' || !/^Bearer [^\s]+$/.test(user))
      throw facadeError(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
    metadata.set('x-cab-user-authorization',user);
    let principal:Data;
    try {
      principal=await unaryCall<Data,Data>(this.client,this.identity,'VerifyUserIdentity',
        {allowed_roles:['CUSTOMER','DRIVER','OPERATOR']},metadata,900);
    } catch (error) {
      if ((error as grpc.ServiceError).code===grpc.status.UNAUTHENTICATED)
        throw facadeError(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if ((error as grpc.ServiceError).code===grpc.status.PERMISSION_DENIED)
        throw facadeError(grpc.status.PERMISSION_DENIED,'ACCOUNT_NOT_ACTIVE');
      throw facadeError(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if (principal.role==='DRIVER') throw facadeError(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    if (principal.role==='CUSTOMER' && principal.customer_id!==customerId)
      throw facadeError(grpc.status.NOT_FOUND,'CUSTOMER_NOT_FOUND');
    if (!['CUSTOMER','OPERATOR'].includes(String(principal.role)))
      throw facadeError(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const rows=await this.db.$queryRaw<{account_id:string;customer_id:string}[]>`
      SELECT c.account_id,c.customer_id FROM customer c
      JOIN customer_provision p ON p.operation_id=c.provision_operation_id
      WHERE c.customer_id=${customerId}::uuid AND p.state='PROVISIONED'`;
    if (!rows[0]) throw facadeError(grpc.status.NOT_FOUND,'CUSTOMER_NOT_FOUND');
    const target=rows[0];
    let contact:Data;
    try {
      contact=await unaryCall<Data,Data>(this.client,this.identity,'GetAccountContact',{
        account_id:target.account_id,
        purpose:principal.role==='OPERATOR'?'OPERATIONS_PROFILE':'OWN_PROFILE',
      },metadata,900);
    } catch {throw facadeError(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');}
    return mapCustomerProfile(target.account_id,target.customer_id,contact);
  }
}
