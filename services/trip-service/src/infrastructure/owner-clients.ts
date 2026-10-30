import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,decodeFacadeError,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {record,type Data} from '../application/trip-ledger.js';

const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
const stable=(value:unknown):string=>JSON.stringify(value,(_key,current)=>
  record(current)?Object.fromEntries(Object.keys(current).sort().map(key=>[key,current[key]])):current);
export class OwnerClients {
  private readonly identity:grpc.Client;
  private readonly booking:grpc.Client;
  private readonly customer:grpc.Client;
  private readonly driver:grpc.Client;
  private readonly payment:grpc.Client;
  private readonly definitions={
    identity:serviceDefinition('cab.internal.v1.IdentityInternalService','proto/cab/internal/v1/identity.proto'),
    booking:serviceDefinition('cab.internal.v1.BookingInternalService','proto/cab/internal/v1/booking.proto'),
    customer:serviceDefinition('cab.internal.v1.CustomerInternalService','proto/cab/internal/v1/customer.proto'),
    driver:serviceDefinition('cab.internal.v1.DriverInternalService','proto/cab/internal/v1/driver.proto'),
    payment:serviceDefinition('cab.internal.v1.PaymentInternalService','proto/cab/internal/v1/payment.proto')};
  constructor() {
    const tls=readTlsFromEnvironment('TRIP_SERVICE');
    const target=(name:string)=>{const value=process.env[`${name.toUpperCase()}_SERVICE_GRPC_TARGET`];
      if(!value) throw new Error('Trip owner target configuration missing');return value;};
    this.identity=createClient(target('identity'),tls,'identity-service');
    this.booking=createClient(target('booking'),tls,'booking-service');
    this.customer=createClient(target('customer'),tls,'customer-service');
    this.driver=createClient(target('driver'),tls,'driver-service');
    this.payment=createClient(target('payment'),tls,'payment-service');
  }
  close():void {for(const client of [this.identity,this.booking,this.customer,this.driver,this.payment])
    client.close();}
  private metadata(token?:string):grpc.Metadata {const value=new grpc.Metadata();
    value.set('x-correlation-id',randomUUID());if(token) value.set('x-cab-user-authorization',token);
    return value;}
  private async call(client:grpc.Client,definition:ReturnType<typeof serviceDefinition>,
    method:string,body:Data,token?:string,deadline=900):Promise<Data> {
    try {return await unaryCall<Data,Data>(client,definition,method,body,this.metadata(token),deadline);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if(code===grpc.status.NOT_FOUND) throw fail(grpc.status.NOT_FOUND,'OWNER_NOT_FOUND');
      if(code===grpc.status.FAILED_PRECONDITION) throw fail(grpc.status.FAILED_PRECONDITION,'OWNER_FENCE_CONFLICT');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    }
  }
  token(metadata:grpc.Metadata):string {const value=metadata.get('x-cab-user-authorization')[0];
    if(typeof value!=='string'||!/^Bearer [^\s]+$/.test(value))
      throw facadeError(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    return value;}
  async principal(metadata:grpc.Metadata):Promise<{accountId:string;role:string;customerId?:string;driverId?:string}> {
    const token=this.token(metadata);let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.definitions.identity,'VerifyUserIdentity',
      {allowed_roles:['CUSTOMER','DRIVER','OPERATOR']},this.metadata(token),900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if(code===grpc.status.UNAUTHENTICATED)
        throw facadeError(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if(code===grpc.status.PERMISSION_DENIED) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    }
    if(typeof value.account_id!=='string'||
        !['CUSTOMER','DRIVER','OPERATOR'].includes(String(value.role)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return {accountId:value.account_id,role:String(value.role),
      customerId:typeof value.customer_id==='string'?value.customer_id:undefined,
      driverId:typeof value.driver_id==='string'?value.driver_id:undefined};
  }
  async verifyPreparation(input:Data,phase:'PREPARING'|'ACTIVATING'):Promise<void> {
    const assignmentId=String(input.assignment_id);
    const decision=await this.call(this.booking,this.definitions.booking,
      'GetAssignmentDecision',{assignment_id:assignmentId});
    const ref=record(input.reservation)?input.reservation:{};
    const parties=record(input.parties)?input.parties:{};
    if(decision.assignment_id!==assignmentId||decision.booking_id!==input.booking_id||
        decision.trip_id!==input.trip_id||decision.state!==phase||decision.cancel_requested===true||
        decision.customer_id!==parties.customer_id||decision.driver_id!==parties.driver_id||
        decision.vehicle_id!==parties.vehicle_id||
        stable(decision.parties)!==stable(input.parties)||
        stable(decision.guard)!==stable(input.guard)||
        stable(decision.pickup)!==stable(input.pickup)||
        stable(decision.destination)!==stable(input.destination)||
        stable(decision.pricing)!==stable(input.pricing))
      throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_MISMATCH');
    const reservation=await this.call(this.driver,this.definitions.driver,
      'GetReservation',{assignment_id:assignmentId});
    if(!record(reservation.reservation)||reservation.reservation.reservation_id!==ref.reservation_id||
        reservation.reservation.generation!==ref.generation||
        reservation.reservation.driver_id!==parties.driver_id||
        reservation.reservation.vehicle_id!==parties.vehicle_id||
        (phase==='PREPARING'&&reservation.state!=='HELD')||
        (phase==='ACTIVATING'&&(reservation.state!=='BOUND'||reservation.trip_id!==input.trip_id)))
      throw fail(grpc.status.FAILED_PRECONDITION,'RESERVATION_MISMATCH');
    if(phase==='ACTIVATING') {
      const guard=await this.call(this.customer,this.definitions.customer,'GetGuard',
        {guard:input.guard as Data});
      const guardRef=record(input.guard)?input.guard:{};
      if(!record(guard.guard)||guard.guard.guard_id!==guardRef.guard_id||
          guard.guard.generation!==guardRef.generation||guard.state!=='TRIP_BOUND'||
          guard.trip_id!==input.trip_id||guard.assignment_id!==assignmentId)
        throw fail(grpc.status.FAILED_PRECONDITION,'GUARD_MISMATCH');
    }
  }
  async paymentDecision(tripId:string):Promise<Data> {
    try {return await unaryCall<Data,Data>(this.payment,this.definitions.payment,
      'GetTripPaymentDecision',{trip_id:tripId},this.metadata(),900);}
    catch(error) {
      const detail=decodeFacadeError(error as grpc.ServiceError);
      if(detail?.code===grpc.status.NOT_FOUND&&detail.reason==='PAYMENT_NOT_FOUND')
        throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_READY');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    }
  }
  async verifyRestore(trip:Data):Promise<number> {
    const tripId=String(trip.trip_id),accountId=String(trip.driver_account_id);
    const reservation=record(trip.reservation_ref)?trip.reservation_ref:{};
    const guard=record(trip.guard_ref)?trip.guard_ref:{};
    const [account,driver,customer]=await Promise.all([
      this.call(this.identity,this.definitions.identity,'VerifyAccountEligibility',
        {account_id:accountId,expected_role:'DRIVER'},undefined,1000),
      this.call(this.driver,this.definitions.driver,'CheckTripRestoreEligibility',
        {trip_id:tripId,driver_account_id:accountId,reservation},undefined,1000),
      this.call(this.customer,this.definitions.customer,'GetGuard',{guard},undefined,1000)]);
    const guardRef=record(customer.guard)?customer.guard:{};
    if(account.account_id!==accountId||account.role!=='DRIVER'||!account.verified_at||
        driver.trip_id!==tripId||driver.eligible!==true||!driver.verified_at||
        customer.state!=='TRIP_BOUND'||customer.trip_id!==tripId||
        customer.assignment_id!==trip.assignment_id||
        guardRef.guard_id!==guard.guard_id||String(guardRef.generation)!==String(guard.generation))
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_RESOLVABLE');
    return Date.now();
  }
  async trackingDriver(tripId:string,accountId:string,token:string):Promise<Data> {
    const result=await this.call(this.identity,this.definitions.identity,'GetAccountContact',
      {account_id:accountId,purpose:'ACTIVE_TRIP_CONTACT',trip_id:tripId},token);
    if(result.account_id!==accountId||typeof result.full_name!=='string'||
        !result.full_name.trim()) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return result;
  }
  async trackingVehicle(tripId:string,driverId:string,vehicleId:string,token:string):Promise<Data> {
    const result=await this.call(this.driver,this.definitions.driver,'GetTripVehicle',
      {trip_id:tripId,driver_id:driverId,vehicle_id:vehicleId},token);
    if(result.vehicle_id!==vehicleId||typeof result.plate_number!=='string'||
        !result.plate_number.trim()||!['STANDARD','PREMIUM','MOTORBIKE','VAN']
          .includes(String(result.vehicle_type)))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return result;
  }
  async fenceCancellation(tripId:string,cancellationId:string):Promise<Data> {
    return this.call(this.payment,this.definitions.payment,'RecordTripCancellation',
      {trip_id:tripId,cancellation_id:cancellationId},undefined,1800);}
  async releaseGuard(guard:Data,tripId:string,closureId:string):Promise<Data> {
    return this.call(this.customer,this.definitions.customer,'ReleaseGuard',{
      command:{command_id:closureId,operation_id:closureId},guard,trip_id:tripId,
      closure_operation_id:closureId},undefined,1800);
  }
  async releaseReservation(reservation:Data,tripId:string,closureId:string):Promise<Data> {
    return this.call(this.driver,this.definitions.driver,'ReleaseReservation',{
      command:{command_id:closureId,operation_id:closureId},reservation,trip_id:tripId,
      closure_operation_id:closureId},undefined,1800);
  }
}
