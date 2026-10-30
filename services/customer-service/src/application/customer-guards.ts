import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import type {PrismaClient} from '../infrastructure/prisma/generated/client.js';

type Data=Record<string,unknown>;
type Guard={guard_id:string;customer_id:string;booking_id:string;operation_id:string;
  generation:bigint;state:string;trip_id:string|null;assignment_id:string|null;
  version:bigint;updated_at:Date};
type Cancellation={booking_id:string;customer_id:string;operation_id:string;cancelled_at:Date};
const record=(value:unknown):value is Data=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=(value:unknown)=>{if(typeof value!=='string'||!uuid.test(value))
  throw facadeError(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');return value;};
const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
const command=(value:unknown)=>{if(!record(value)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return {commandId:id(value.command_id),operationId:id(value.operation_id)};};
const reference=(value:unknown)=>{if(!record(value)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  const generation=String(value.generation);
  if(!/^[1-9][0-9]*$/.test(generation)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return {guardId:id(value.guard_id),customerId:id(value.customer_id),
    bookingId:id(value.booking_id),generation};};
const dto=(row:Guard):Data=>({guard:{guard_id:row.guard_id,customer_id:row.customer_id,
  booking_id:row.booking_id,generation:String(row.generation)},state:row.state,
  ...(row.trip_id?{trip_id:row.trip_id}:{}),
  ...(row.assignment_id?{assignment_id:row.assignment_id}:{}),
  version:String(row.version),updated_at:stamp(row.updated_at)});

export class CustomerGuards {
  private readonly booking:grpc.Client;
  private readonly trip:grpc.Client;
  private readonly bookingDef=serviceDefinition('cab.internal.v1.BookingInternalService',
    'proto/cab/internal/v1/booking.proto');
  private readonly tripDef=serviceDefinition('cab.internal.v1.TripInternalService',
    'proto/cab/internal/v1/trip.proto');
  constructor(private readonly db:PrismaClient) {
    const booking=process.env.BOOKING_SERVICE_GRPC_TARGET;
    const trip=process.env.TRIP_SERVICE_GRPC_TARGET;
    if(!booking||!trip) throw new Error('Customer guard owner target missing');
    const tls=readTlsFromEnvironment('CUSTOMER_SERVICE');
    this.booking=createClient(booking,tls,'booking-service');
    this.trip=createClient(trip,tls,'trip-service');
  }
  close():void {this.booking.close();this.trip.close();}
  private metadata():grpc.Metadata {const result=new grpc.Metadata();
    result.set('x-correlation-id',randomUUID());return result;}
  private async owner(client:grpc.Client,def:ReturnType<typeof serviceDefinition>,
    method:string,request:Data):Promise<Data> {
    try {return await unaryCall<Data,Data>(client,def,method,request,this.metadata(),900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      console.warn(`customer guard owner ${method} unavailable; category=${typeof code==='number'?code:'internal'}`);
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    }
  }
  private async bookingDecision(bookingId:string,customerId:string,
    disposition:'KEEP_BOOKING_GUARD'|'RELEASE_BOOKING_GUARD'):Promise<Data> {
    const value=await this.owner(this.booking,this.bookingDef,'GetBookingGuardDecision',
      {id:bookingId});
    if(value.booking_id!==bookingId||value.customer_id!==customerId||
        value.disposition!==disposition||typeof value.operation_id!=='string'||
        !uuid.test(value.operation_id)) throw fail(grpc.status.FAILED_PRECONDITION,'GUARD_DECISION_CHANGED');
    return value;
  }
  private async preparation(assignmentId:string):Promise<Data> {
    return this.owner(this.trip,this.tripDef,'GetTripPreparation',{assignment_id:assignmentId});
  }
  private async closure(tripId:string,operationId:string):Promise<Data> {
    const value=await this.owner(this.trip,this.tripDef,'GetClosureContext',
      {trip_id:tripId,closure_operation_id:operationId});
    if(value.trip_id!==tripId||value.closure_operation_id!==operationId||
        !record(value.guard)) throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
    return value;
  }
  private assertRow(row:Guard|undefined,ref:ReturnType<typeof reference>):Guard {
    if(!row||row.guard_id!==ref.guardId||row.customer_id!==ref.customerId||
        row.booking_id!==ref.bookingId||String(row.generation)!==ref.generation)
      throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
    return row;
  }
  async acquire(request:unknown):Promise<Data> {
    const data=record(request)?request:{};
    const customerId=id(data.customer_id),bookingId=id(data.booking_id),cmd=command(data.command);
    const decision=await this.bookingDecision(bookingId,customerId,'KEEP_BOOKING_GUARD');
    if(decision.operation_id!==cmd.operationId)
      throw fail(grpc.status.FAILED_PRECONDITION,'GUARD_DECISION_CHANGED');
    try {return await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${customerId}))`;
      const customer=await tx.$queryRaw<{customer_id:string}[]>`
        SELECT customer_id FROM customer WHERE customer_id=${customerId}::uuid`;
      if(!customer[0]) throw fail(grpc.status.NOT_FOUND,'CUSTOMER_NOT_FOUND');
      const fenced=await tx.$queryRaw<Cancellation[]>`
        SELECT * FROM customer_guard_cancellation WHERE booking_id=${bookingId}::uuid`;
      if(fenced[0]) throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_GUARD_CANCELLED');
      const existing=await tx.$queryRaw<Guard[]>`
        SELECT * FROM customer_activity_guard WHERE booking_id=${bookingId}::uuid FOR UPDATE`;
      if(existing[0]) {
        if(existing[0].customer_id!==customerId||existing[0].operation_id!==cmd.operationId||
            existing[0].state==='GUARD_RELEASED')
          throw fail(grpc.status.ALREADY_EXISTS,'ACTIVE_CUSTOMER_ACTIVITY');
        return dto(existing[0]);
      }
      const active=await tx.$queryRaw<Guard[]>`
        SELECT * FROM customer_activity_guard WHERE customer_id=${customerId}::uuid
        AND state<>'GUARD_RELEASED' FOR UPDATE`;
      if(active[0]) throw fail(grpc.status.ALREADY_EXISTS,'ACTIVE_CUSTOMER_ACTIVITY');
      const next=await tx.$queryRaw<{next_generation:bigint}[]>`
        INSERT INTO customer_guard_generation(customer_id,next_generation)
        VALUES(${customerId}::uuid,2) ON CONFLICT(customer_id) DO UPDATE
        SET next_generation=customer_guard_generation.next_generation+1
        RETURNING next_generation`;
      const generation=next[0]!.next_generation-1n,guardId=randomUUID();
      const rows=await tx.$queryRaw<Guard[]>`
        INSERT INTO customer_activity_guard
        (guard_id,customer_id,booking_id,operation_id,generation,state)
        VALUES(${guardId}::uuid,${customerId}::uuid,${bookingId}::uuid,
          ${cmd.operationId}::uuid,${generation},'BOOKING_HELD') RETURNING *`;
      return dto(rows[0]!);
    });} catch(error) {if((error as {code?:string}).code==='P2002')
      throw fail(grpc.status.ALREADY_EXISTS,'ACTIVE_CUSTOMER_ACTIVITY');
      console.warn(`customer guard acquire failed; category=${String((error as {code?:unknown}).code??'internal')}`);
      throw error;}
  }
  async get(request:unknown):Promise<Data> {
    const ref=reference(record(request)?request.guard:undefined);
    const rows=await this.db.$queryRaw<Guard[]>`
      SELECT * FROM customer_activity_guard WHERE guard_id=${ref.guardId}::uuid`;
    return dto(this.assertRow(rows[0],ref));
  }
  async bind(request:unknown):Promise<Data> {
    const data=record(request)?request:{},ref=reference(data.guard);
    command(data.command);
    const tripId=id(data.trip_id),assignmentId=id(data.assignment_id);
    const prep=await this.preparation(assignmentId);
    if(prep.state!=='PREPARED'||prep.trip_id!==tripId||prep.booking_id!==ref.bookingId)
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_PREPARATION_MISMATCH');
    return this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<Guard[]>`
        SELECT * FROM customer_activity_guard WHERE guard_id=${ref.guardId}::uuid FOR UPDATE`;
      const row=this.assertRow(rows[0],ref);
      if(row.state==='TRIP_BOUND'&&row.trip_id===tripId&&row.assignment_id===assignmentId)
        return dto(row);
      if(row.state!=='BOOKING_HELD') throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      const changed=await tx.$queryRaw<Guard[]>`
        UPDATE customer_activity_guard SET state='TRIP_BOUND',trip_id=${tripId}::uuid,
          assignment_id=${assignmentId}::uuid,version=version+1,updated_at=now()
        WHERE guard_id=${ref.guardId}::uuid AND state='BOOKING_HELD' RETURNING *`;
      if(!changed[0]) throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      return dto(changed[0]);
    });
  }
  async restore(request:unknown):Promise<Data> {
    const data=record(request)?request:{},ref=reference(data.guard);
    command(data.command);
    const tripId=id(data.trip_id),assignmentId=id(data.assignment_id);
    const prep=await this.preparation(assignmentId);
    if(prep.state!=='PREPARATION_CANCELLED'||prep.trip_id!==tripId||
        prep.booking_id!==ref.bookingId)
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_CANCELLED');
    return this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<Guard[]>`
        SELECT * FROM customer_activity_guard WHERE guard_id=${ref.guardId}::uuid FOR UPDATE`;
      const row=this.assertRow(rows[0],ref);
      if(row.state==='BOOKING_HELD') return dto(row);
      if(row.state!=='TRIP_BOUND'||row.trip_id!==tripId||row.assignment_id!==assignmentId)
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      const changed=await tx.$queryRaw<Guard[]>`
        UPDATE customer_activity_guard SET state='BOOKING_HELD',trip_id=NULL,
          assignment_id=NULL,version=version+1,updated_at=now()
        WHERE guard_id=${ref.guardId}::uuid RETURNING *`;
      return dto(changed[0]!);
    });
  }
  async release(request:unknown):Promise<Data> {
    const data=record(request)?request:{},ref=reference(data.guard);
    command(data.command);
    const tripId=data.trip_id===undefined?undefined:id(data.trip_id);
    const operationId=data.closure_operation_id===undefined?undefined:id(data.closure_operation_id);
    if(Boolean(tripId)!==Boolean(operationId)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    if(tripId) {
      const closed=await this.closure(tripId,operationId!);
      const owner=closed.guard as Data;
      if(owner.guard_id!==ref.guardId||owner.customer_id!==ref.customerId||
          owner.booking_id!==ref.bookingId||String(owner.generation)!==ref.generation)
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
    } else await this.bookingDecision(ref.bookingId,ref.customerId,'RELEASE_BOOKING_GUARD');
    return this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<Guard[]>`
        SELECT * FROM customer_activity_guard WHERE guard_id=${ref.guardId}::uuid FOR UPDATE`;
      const row=this.assertRow(rows[0],ref);
      if(row.state==='GUARD_RELEASED') return dto(row);
      if(tripId ? row.state!=='TRIP_BOUND'||row.trip_id!==tripId : row.state!=='BOOKING_HELD')
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      const changed=await tx.$queryRaw<Guard[]>`
        UPDATE customer_activity_guard SET state='GUARD_RELEASED',trip_id=NULL,
          assignment_id=NULL,version=version+1,updated_at=now()
        WHERE guard_id=${ref.guardId}::uuid RETURNING *`;
      return dto(changed[0]!);
    });
  }
  async cancelBooking(request:unknown):Promise<Data> {
    const data=record(request)?request:{},bookingId=id(data.booking_id),
      customerId=id(data.customer_id),cmd=command(data.command);
    const decision=await this.bookingDecision(bookingId,customerId,'RELEASE_BOOKING_GUARD');
    if(decision.operation_id!==cmd.operationId)
      throw fail(grpc.status.FAILED_PRECONDITION,'GUARD_DECISION_CHANGED');
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${customerId}))`;
      const prior=await tx.$queryRaw<Cancellation[]>`
        SELECT * FROM customer_guard_cancellation WHERE booking_id=${bookingId}::uuid FOR UPDATE`;
      if(prior[0]&&(prior[0].customer_id!==customerId||prior[0].operation_id!==cmd.operationId))
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      const held=await tx.$queryRaw<Guard[]>`
        SELECT * FROM customer_activity_guard WHERE booking_id=${bookingId}::uuid FOR UPDATE`;
      if(held[0]&&held[0].state==='TRIP_BOUND')
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_STILL_BOUND');
      if(!prior[0]) await tx.$executeRaw`INSERT INTO customer_guard_cancellation
        (booking_id,customer_id,operation_id) VALUES
        (${bookingId}::uuid,${customerId}::uuid,${cmd.operationId}::uuid)`;
      if(held[0]?.state==='BOOKING_HELD') await tx.$executeRaw`
        UPDATE customer_activity_guard SET state='GUARD_RELEASED',version=version+1,
          updated_at=now() WHERE guard_id=${held[0].guard_id}::uuid`;
      const result=await tx.$queryRaw<Cancellation[]>`
        SELECT * FROM customer_guard_cancellation WHERE booking_id=${bookingId}::uuid`;
      return {booking_id:bookingId,customer_id:customerId,
        cancelled_at:stamp(result[0]!.cancelled_at)};
    });
  }
}
