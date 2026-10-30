import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,decodeFacadeError,facadeError,readTlsFromEnvironment,
  serviceDefinition,unaryCall} from '@cab/grpc-transport';

type Data=Record<string,unknown>;
const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>
  facadeError(code,reason,origin);
export type Principal={accountId:string;role:'CUSTOMER'|'DRIVER'|'OPERATOR';
  customerId?:string;driverId?:string};
export class RatingOwners {
  private readonly identity:grpc.Client;
  private readonly trip:grpc.Client;
  private readonly identityDef=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  private readonly tripDef=serviceDefinition('cab.internal.v1.TripInternalService',
    'proto/cab/internal/v1/trip.proto');
  constructor() {
    const identity=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    const trip=process.env.TRIP_SERVICE_GRPC_TARGET;
    if(!identity||!trip) throw new Error('Rating owner target configuration missing');
    const tls=readTlsFromEnvironment('RATING_SERVICE');
    this.identity=createClient(identity,tls,'identity-service');
    this.trip=createClient(trip,tls,'trip-service');
  }
  close():void {this.identity.close();this.trip.close();}
  private metadata(token:string,source:grpc.Metadata):grpc.Metadata {
    const value=new grpc.Metadata();value.set('x-cab-user-authorization',token);
    const correlation=source.get('x-correlation-id')[0];
    value.set('x-correlation-id',typeof correlation==='string'?correlation:randomUUID());
    return value;
  }
  token(metadata:grpc.Metadata):string {
    const value=metadata.get('x-cab-user-authorization')[0];
    if(typeof value!=='string'||!/^Bearer [^\s]+$/.test(value))
      throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    return value;
  }
  async principal(metadata:grpc.Metadata,allowed:string[]):Promise<Principal> {
    const token=this.token(metadata);let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.identityDef,
      'VerifyRatingUserIdentity',{allowed_roles:allowed},this.metadata(token,metadata),900);}
    catch(error) {const detail=decodeFacadeError(error as grpc.ServiceError);
      if(detail?.code===grpc.status.UNAUTHENTICATED&&detail.origin==='END_USER')
        throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if(detail?.code===grpc.status.PERMISSION_DENIED)
        throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');}
    if(typeof value.account_id!=='string'||!id.test(value.account_id)||
        !allowed.includes(String(value.role))||!value.session_id||!value.verified_at||
        !value.account_version)
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    const role=value.role as Principal['role'];
    if(role==='CUSTOMER'&&(typeof value.customer_id!=='string'||!id.test(value.customer_id))||
       role==='DRIVER'&&(typeof value.driver_id!=='string'||!id.test(value.driver_id)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return {accountId:value.account_id,role,
      customerId:role==='CUSTOMER'?String(value.customer_id):undefined,
      driverId:role==='DRIVER'?String(value.driver_id):undefined};
  }
  async tripContext(tripId:string,metadata:grpc.Metadata):Promise<Data> {
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.trip,this.tripDef,'GetTripRatingContext',
      {trip_id:tripId},this.metadata(this.token(metadata),metadata),900);}
    catch(error) {const detail=decodeFacadeError(error as grpc.ServiceError);
      if(detail?.code===grpc.status.NOT_FOUND)
        throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
      if(detail?.code===grpc.status.UNAUTHENTICATED&&detail.origin==='END_USER')
        throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if(detail?.code===grpc.status.PERMISSION_DENIED)
        throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');}
    if(value.trip_id!==tripId||typeof value.customer_id!=='string'||
        !id.test(value.customer_id)||typeof value.driver_id!=='string'||
        !id.test(value.driver_id)||!['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP',
          'IN_PROGRESS','COMPLETED','CANCELLED','ERROR'].includes(String(value.trip_status))||
        !/^[1-9]\d*$/.test(String(value.trip_version)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    if(value.trip_status==='COMPLETED'&&!value.completed_at)
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return value;
  }
}
