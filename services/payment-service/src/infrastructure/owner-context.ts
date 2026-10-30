import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import type pg from 'pg';
import {fareForPriceVnd} from '../domain/pricing.js';
import type {VerifiedObligation} from '../application/payment-ledger.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
export const sameSnapshotValue=(left:unknown,right:unknown):boolean=>{
  const canonical=(value:unknown)=>JSON.stringify(value,(_key,item:unknown)=>
    record(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  return canonical(left)===canonical(right);
};
const fail=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>facadeError(code,reason,origin);
const definition=(name:string,file:string)=>serviceDefinition(name,file);
export type Principal={accountId:string;role:'CUSTOMER'|'DRIVER'|'OPERATOR';
  customerId?:string;driverId?:string};

export class OwnerContext {
  private readonly identity:grpc.Client;
  private readonly trip:grpc.Client;
  private readonly booking:grpc.Client;
  private readonly identityDef=definition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  private readonly tripDef=definition('cab.internal.v1.TripInternalService',
    'proto/cab/internal/v1/trip.proto');
  private readonly bookingDef=definition('cab.internal.v1.BookingInternalService',
    'proto/cab/internal/v1/booking.proto');
  constructor(private readonly db:pg.Pool) {
    const identity=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    const trip=process.env.TRIP_SERVICE_GRPC_TARGET;
    const booking=process.env.BOOKING_SERVICE_GRPC_TARGET;
    if (!identity||!trip||!booking) throw new Error('Payment owner target configuration missing');
    const tls=readTlsFromEnvironment('PAYMENT_SERVICE');
    this.identity=createClient(identity,tls,'identity-service');
    this.trip=createClient(trip,tls,'trip-service');
    this.booking=createClient(booking,tls,'booking-service');
  }
  close():void {this.identity.close();this.trip.close();this.booking.close();}
  private metadata(user?:string):grpc.Metadata {
    const result=new grpc.Metadata();result.set('x-correlation-id',randomUUID());
    if (user) result.set('x-cab-user-authorization',user);
    return result;
  }
  private token(metadata:grpc.Metadata):string {
    const token=metadata.get('x-cab-user-authorization')[0];
    if (typeof token!=='string'||!/^Bearer [^\s]+$/.test(token))
      throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    return token;
  }
  key(metadata:grpc.Metadata):string {
    const value=metadata.get('x-cab-idempotency-key')[0];
    if (typeof value!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(value))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return value;
  }
  async principal(metadata:grpc.Metadata):Promise<Principal> {
    const token=this.token(metadata);
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.identityDef,
      'VerifyUserIdentity',{allowed_roles:['CUSTOMER','DRIVER','OPERATOR']},
      this.metadata(token),900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if (code===grpc.status.UNAUTHENTICATED)
        throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if (code===grpc.status.PERMISSION_DENIED)
        throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if (typeof value.account_id!=='string'||
        !['CUSTOMER','DRIVER','OPERATOR'].includes(String(value.role)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return {accountId:value.account_id,role:value.role as Principal['role'],
      customerId:typeof value.customer_id==='string'?value.customer_id:undefined,
      driverId:typeof value.driver_id==='string'?value.driver_id:undefined};
  }
  async tripContext(tripId:string,metadata:grpc.Metadata):Promise<Data> {
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.trip,this.tripDef,
      'GetTripPaymentContext',{trip_id:tripId},this.metadata(this.token(metadata)),900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if (code===grpc.status.NOT_FOUND) throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
      if (code===grpc.status.PERMISSION_DENIED) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      if (code===grpc.status.UNAUTHENTICATED)
        throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if (value.trip_id!==tripId||!record(value.parties)||
        !['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS','COMPLETED','CANCELLED','ERROR']
          .includes(String(value.trip_status)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return value;
  }
  async obligation(trip:Data):Promise<VerifiedObligation> {
    let booking:Data;
    try {booking=await unaryCall<Data,Data>(this.booking,this.bookingDef,
      'GetBookingPaymentContext',{trip_id:trip.trip_id},this.metadata(),900);}
    catch {throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');}
    const parties=trip.parties as Data;
    if (typeof parties.customer_account_id!=='string'||
        typeof parties.driver_account_id!=='string')
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    const pricing=record(booking.pricing)?booking.pricing:undefined;
    if (booking.trip_id!==trip.trip_id||
        booking.customer_id!==parties.customer_id||booking.driver_id!==parties.driver_id||
        typeof booking.booking_id!=='string'||typeof booking.pricing_operation_id!=='string'||
        !pricing||pricing.vehicle_type!=='MOTORBIKE'||pricing.currency!=='VND'||
        !/^[1-9][0-9]*$/.test(String(pricing.distance_meters))||
        !/^(0|[1-9][0-9]*)$/.test(String(pricing.total_amount))||
        typeof pricing.pricing_version_id!=='string'||typeof pricing.route_id!=='string'||
        !/^[1-9][0-9]*$/.test(String(pricing.route_version)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    const perKm=record(pricing.price_per_km)?pricing.price_per_km.value:undefined;
    if (typeof perKm!=='string'||
        fareForPriceVnd(BigInt(String(pricing.distance_meters)),perKm)!==
          BigInt(String(pricing.total_amount)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    const captured=await this.db.query<{snapshot:Data}>(
      'SELECT snapshot FROM pricing_capture WHERE operation_id=$1',[booking.pricing_operation_id]);
    const original=captured.rows[0]?.snapshot;
    const immutable=['pricing_version_id','vehicle_type','base_fare','price_per_km',
      'price_per_minute','currency','accepted_at','route_id','route_version',
      'distance_meters','total_amount'];
    if (!original||immutable.some(field=>
      !sameSnapshotValue(original[field],pricing[field])))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return {tripId:String(trip.trip_id),bookingId:booking.booking_id,
      customerId:String(booking.customer_id),driverId:String(booking.driver_id),
      customerAccountId:parties.customer_account_id,
      driverAccountId:parties.driver_account_id,
      pricingVersionId:pricing.pricing_version_id,routeId:pricing.route_id,
      routeVersion:String(pricing.route_version),distanceMeters:String(pricing.distance_meters),
      amountVnd:String(pricing.total_amount),pricingSnapshot:pricing};
  }
  authorize(principal:Principal,trip:Data,action:'CUSTOMER'|'DRIVER'|'READ'):void {
    const parties=trip.parties as Data;
    if (action==='CUSTOMER'&&principal.role!=='CUSTOMER'||
        action==='DRIVER'&&principal.role!=='DRIVER')
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    if (principal.role==='CUSTOMER'&&principal.customerId!==parties.customer_id||
        principal.role==='DRIVER'&&principal.driverId!==parties.driver_id)
      throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
  }
}
