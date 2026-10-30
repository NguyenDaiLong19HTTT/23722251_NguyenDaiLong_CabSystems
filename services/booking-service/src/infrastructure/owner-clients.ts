import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';

export type Data=Record<string,unknown>;
export const record=(value:unknown):value is Data=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
const fail=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>
  facadeError(code,reason,origin);
export type Principal={accountId:string;customerId?:string;driverId?:string;role:string};

export class BookingOwners {
  private readonly identity:grpc.Client;
  private readonly customer:grpc.Client;
  private readonly driver:grpc.Client;
  private readonly trip:grpc.Client;
  private readonly payment:grpc.Client;
  private readonly defs={
    identity:serviceDefinition('cab.internal.v1.IdentityInternalService',
      'proto/cab/internal/v1/identity.proto'),
    customer:serviceDefinition('cab.internal.v1.CustomerInternalService',
      'proto/cab/internal/v1/customer.proto'),
    driver:serviceDefinition('cab.internal.v1.DriverInternalService',
      'proto/cab/internal/v1/driver.proto'),
    trip:serviceDefinition('cab.internal.v1.TripInternalService',
      'proto/cab/internal/v1/trip.proto'),
    payment:serviceDefinition('cab.internal.v1.PaymentInternalService',
      'proto/cab/internal/v1/payment.proto'),
  };
  constructor() {
    const tls=readTlsFromEnvironment('BOOKING_SERVICE');
    const target=(name:string)=>{const value=process.env[`${name.toUpperCase()}_SERVICE_GRPC_TARGET`];
      if(!value) throw new Error('Booking owner target missing');return value;};
    this.identity=createClient(target('identity'),tls,'identity-service');
    this.customer=createClient(target('customer'),tls,'customer-service');
    this.driver=createClient(target('driver'),tls,'driver-service');
    this.trip=createClient(target('trip'),tls,'trip-service');
    this.payment=createClient(target('payment'),tls,'payment-service');
  }
  close():void {for(const client of [this.identity,this.customer,this.driver,this.trip,this.payment])
    client.close();}
  private metadata(token?:string):grpc.Metadata {const result=new grpc.Metadata();
    result.set('x-correlation-id',randomUUID());
    if(token) result.set('x-cab-user-authorization',token);return result;}
  async call(owner:'customer'|'driver'|'trip'|'payment',method:string,body:Data,
    deadline=1700):Promise<Data> {
    try {return await unaryCall<Data,Data>(this[owner],this.defs[owner],
      method,body,this.metadata(),deadline);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if(code===grpc.status.ALREADY_EXISTS||code===grpc.status.FAILED_PRECONDITION||
          code===grpc.status.INVALID_ARGUMENT||code===grpc.status.NOT_FOUND)
        throw error;
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
  }
  async principal(metadata:grpc.Metadata,allowed:string[]):Promise<Principal> {
    const token=metadata.get('x-cab-user-authorization')[0];
    if(typeof token!=='string'||!/^Bearer [^\s]+$/.test(token))
      throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.defs.identity,
      'VerifyUserIdentity',{allowed_roles:allowed},this.metadata(token),900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if(code===grpc.status.UNAUTHENTICATED)
        throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if(code===grpc.status.PERMISSION_DENIED) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if(typeof value.account_id!=='string'||!allowed.includes(String(value.role)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return {accountId:value.account_id,role:String(value.role),
      customerId:typeof value.customer_id==='string'?value.customer_id:undefined,
      driverId:typeof value.driver_id==='string'?value.driver_id:undefined};
  }
}
