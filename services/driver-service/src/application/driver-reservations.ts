import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import type {PrismaClient} from '../infrastructure/prisma/generated/client.js';

type Data=Record<string,unknown>;
type Reservation={reservation_id:string;assignment_id:string;booking_id:string;
  driver_id:string;vehicle_id:string;generation:bigint;state:string;trip_id:string|null;
  version:bigint;updated_at:Date};
type Driver={driver_id:string;account_id:string;approval_status:string;driver_status:string;
  version:bigint};
type Vehicle={vehicle_id:string;vehicle_type:string;vehicle_status:string;version:bigint};
type Cancellation={assignment_id:string;booking_id:string;trip_id:string;cancelled_at:Date};
type Tx=Pick<PrismaClient,'$queryRaw'|'$executeRaw'>;
const record=(value:unknown):value is Data=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
const id=(value:unknown)=>{if(typeof value!=='string'||!uuid.test(value))
  throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');return value;};
const positive=(value:unknown)=>{const text=String(value);if(!/^[1-9][0-9]*$/.test(text))
  throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');return text;};
const command=(value:unknown)=>{if(!record(value)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return {commandId:id(value.command_id),operationId:id(value.operation_id)};};
const reference=(value:unknown)=>{if(!record(value)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return {reservationId:id(value.reservation_id),assignmentId:id(value.assignment_id),
    bookingId:id(value.booking_id),driverId:id(value.driver_id),vehicleId:id(value.vehicle_id),
    generation:positive(value.generation)};};
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
const dto=(row:Reservation):Data=>({reservation:{reservation_id:row.reservation_id,
  generation:String(row.generation),assignment_id:row.assignment_id,booking_id:row.booking_id,
  driver_id:row.driver_id,vehicle_id:row.vehicle_id},state:row.state,
  ...(row.trip_id?{trip_id:row.trip_id}:{}),version:String(row.version),
  updated_at:stamp(row.updated_at)});

export class DriverReservations {
  private readonly booking:grpc.Client;
  private readonly trip:grpc.Client;
  private readonly identity:grpc.Client;
  private readonly bookingDef=serviceDefinition('cab.internal.v1.BookingInternalService',
    'proto/cab/internal/v1/booking.proto');
  private readonly tripDef=serviceDefinition('cab.internal.v1.TripInternalService',
    'proto/cab/internal/v1/trip.proto');
  private readonly identityDef=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  constructor(private readonly db:PrismaClient) {
    const booking=process.env.BOOKING_SERVICE_GRPC_TARGET;
    const trip=process.env.TRIP_SERVICE_GRPC_TARGET;
    const identity=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    if(!booking||!trip||!identity) throw new Error('Driver reservation owner target missing');
    const tls=readTlsFromEnvironment('DRIVER_SERVICE');
    this.booking=createClient(booking,tls,'booking-service');
    this.trip=createClient(trip,tls,'trip-service');
    this.identity=createClient(identity,tls,'identity-service');
  }
  close():void {this.booking.close();this.trip.close();this.identity.close();}
  private metadata():grpc.Metadata {const result=new grpc.Metadata();
    result.set('x-correlation-id',randomUUID());return result;}
  private async owner(client:grpc.Client,def:ReturnType<typeof serviceDefinition>,
    method:string,body:Data):Promise<Data> {
    try {return await unaryCall<Data,Data>(client,def,method,body,this.metadata(),900);}
    catch {throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');}
  }
  private async preparation(assignmentId:string):Promise<Data> {
    return this.owner(this.trip,this.tripDef,'GetTripPreparation',{assignment_id:assignmentId});
  }
  private match(row:Reservation|undefined,ref:ReturnType<typeof reference>):Reservation {
    if(!row||row.reservation_id!==ref.reservationId||
        row.assignment_id!==ref.assignmentId||row.booking_id!==ref.bookingId||
        row.driver_id!==ref.driverId||row.vehicle_id!==ref.vehicleId||
        String(row.generation)!==ref.generation)
      throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
    return row;
  }
  async reserve(request:unknown):Promise<Data> {
    const data=record(request)?request:{};command(data.command);
    const assignmentId=id(data.assignment_id),bookingId=id(data.booking_id),
      driverId=id(data.driver_id),vehicleId=id(data.vehicle_id);
    const driverVersion=positive(data.expected_driver_version),
      vehicleVersion=positive(data.expected_vehicle_version);
    if(data.vehicle_type!=='MOTORBIKE') throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const decision=await this.owner(this.booking,this.bookingDef,'GetAssignmentDecision',
      {assignment_id:assignmentId});
    const parties=record(decision.parties)?decision.parties:{};
    if(decision.assignment_id!==assignmentId||decision.booking_id!==bookingId||
        decision.driver_id!==driverId||decision.vehicle_id!==vehicleId||
        parties.driver_id!==driverId||parties.vehicle_id!==vehicleId||
        !['CLAIMED','PREPARING'].includes(String(decision.state))||
        decision.cancel_requested===true)
      throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_MISMATCH');
    const driverAccountId=id(parties.driver_account_id);
    const eligible=await this.owner(this.identity,this.identityDef,
      'VerifyAccountEligibility',{account_id:driverAccountId,
        expected_role:'DRIVER'});
    if(eligible.account_id!==driverAccountId||eligible.role!=='DRIVER'||
        !eligible.verified_at||!eligible.account_version)
      throw fail(grpc.status.FAILED_PRECONDITION,'DRIVER_NOT_ELIGIBLE');
    try {return await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${assignmentId}))`;
      const tomb=await tx.$queryRaw<Cancellation[]>`
        SELECT * FROM driver_reservation_cancellation WHERE assignment_id=${assignmentId}::uuid`;
      if(tomb[0]) throw fail(grpc.status.FAILED_PRECONDITION,'RESERVATION_CANCELLED');
      const existing=await tx.$queryRaw<Reservation[]>`
        SELECT * FROM driver_reservation WHERE assignment_id=${assignmentId}::uuid FOR UPDATE`;
      if(existing[0]) {
        if(existing[0].booking_id!==bookingId||existing[0].driver_id!==driverId||
            existing[0].vehicle_id!==vehicleId||existing[0].state==='RELEASED')
          throw fail(grpc.status.ALREADY_EXISTS,'RESERVATION_CONFLICT');
        return dto(existing[0]);
      }
      const drivers=await tx.$queryRaw<Driver[]>`
        SELECT driver_id,account_id,approval_status,driver_status,version
        FROM driver_profile WHERE driver_id=${driverId}::uuid FOR UPDATE`;
      const driver=drivers[0];
      if(!driver||driver.approval_status!=='APPROVED'||driver.driver_status!=='AVAILABLE'||
          String(driver.version)!==driverVersion||parties.driver_account_id!==driver.account_id)
        throw fail(grpc.status.FAILED_PRECONDITION,'DRIVER_NOT_ELIGIBLE');
      const vehicles=await tx.$queryRaw<Vehicle[]>`
        SELECT v.vehicle_id,v.vehicle_type,v.vehicle_status,v.version FROM vehicle_assignment a
        JOIN vehicle v ON v.vehicle_id=a.vehicle_id
        WHERE a.driver_id=${driverId}::uuid AND a.ended_at IS NULL
          AND v.vehicle_id=${vehicleId}::uuid FOR UPDATE OF a,v`;
      const vehicle=vehicles[0];
      if(!vehicle||vehicle.vehicle_status!=='ACTIVE'||vehicle.vehicle_type!=='MOTORBIKE'||
          String(vehicle.version)!==vehicleVersion)
        throw fail(grpc.status.FAILED_PRECONDITION,'VEHICLE_NOT_ELIGIBLE');
      const gps=await tx.$queryRaw<{recorded_at:Date}[]>`
        SELECT recorded_at FROM driver_location WHERE driver_id=${driverId}::uuid`;
      if(!gps[0]||gps[0].recorded_at.getTime()<Date.now()-30000||
          gps[0].recorded_at.getTime()>Date.now())
        throw fail(grpc.status.FAILED_PRECONDITION,'LOCATION_STALE');
      // Identity is checked before this local transaction; the DB lock and unique index
      // remain authoritative for concurrent reservations.
      const active=await tx.$queryRaw<Reservation[]>`
        SELECT * FROM driver_reservation WHERE driver_id=${driverId}::uuid
          AND state<>'RELEASED' FOR UPDATE`;
      if(active[0]) throw fail(grpc.status.ALREADY_EXISTS,'RESOURCE_RESERVED');
      const next=await tx.$queryRaw<{next_generation:bigint}[]>`
        INSERT INTO driver_reservation_generation(driver_id,next_generation)
        VALUES(${driverId}::uuid,2) ON CONFLICT(driver_id) DO UPDATE
        SET next_generation=driver_reservation_generation.next_generation+1
        RETURNING next_generation`;
      const generation=next[0]!.next_generation-1n,reservationId=randomUUID();
      const rows=await tx.$queryRaw<Reservation[]>`
        INSERT INTO driver_reservation(reservation_id,assignment_id,booking_id,
          driver_id,vehicle_id,generation,state)
        VALUES(${reservationId}::uuid,${assignmentId}::uuid,${bookingId}::uuid,
          ${driverId}::uuid,${vehicleId}::uuid,${generation},'HELD') RETURNING *`;
      await tx.$executeRaw`UPDATE driver_profile SET driver_status='BUSY',version=version+1,
        updated_at=now() WHERE driver_id=${driverId}::uuid AND driver_status='AVAILABLE'`;
      return dto(rows[0]!);
    });} catch(error) {if((error as {code?:string}).code==='P2002')
      throw fail(grpc.status.ALREADY_EXISTS,'RESOURCE_RESERVED');throw error;}
  }
  async get(request:unknown):Promise<Data> {
    const assignmentId=id(record(request)?request.assignment_id:undefined);
    const rows=await this.db.$queryRaw<Reservation[]>`
      SELECT * FROM driver_reservation WHERE assignment_id=${assignmentId}::uuid`;
    if(!rows[0]) throw fail(grpc.status.NOT_FOUND,'RESERVATION_NOT_FOUND');
    return dto(rows[0]);
  }
  async checkTripRestore(request:unknown):Promise<Data> {
    const input=record(request)?request:{};
    const tripId=id(input.trip_id),accountId=id(input.driver_account_id);
    const ref=reference(input.reservation);
    const rows=await this.db.$queryRaw<{eligible:boolean}[]>`
      SELECT EXISTS (
        SELECT 1 FROM driver_reservation r
        JOIN driver_profile d ON d.driver_id=r.driver_id
        JOIN vehicle v ON v.vehicle_id=r.vehicle_id
        JOIN vehicle_assignment a ON a.driver_id=d.driver_id
          AND a.vehicle_id=v.vehicle_id AND a.ended_at IS NULL
        WHERE r.reservation_id=${ref.reservationId}::uuid
          AND r.assignment_id=${ref.assignmentId}::uuid
          AND r.booking_id=${ref.bookingId}::uuid
          AND r.driver_id=${ref.driverId}::uuid
          AND r.vehicle_id=${ref.vehicleId}::uuid
          AND r.generation=${BigInt(ref.generation)}
          AND r.trip_id=${tripId}::uuid AND r.state='BOUND'
          AND d.account_id=${accountId}::uuid AND d.approval_status='APPROVED'
          AND d.driver_status='BUSY' AND v.vehicle_status='ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM driver_reservation other
            WHERE other.driver_id=r.driver_id AND other.reservation_id<>r.reservation_id
              AND other.state IN ('HELD','BOUND'))
      ) AS eligible`;
    if(rows[0]?.eligible!==true) throw fail(grpc.status.FAILED_PRECONDITION,'DRIVER_NOT_ELIGIBLE');
    return {trip_id:tripId,eligible:true,verified_at:stamp(new Date())};
  }
  async bind(request:unknown):Promise<Data> {
    const data=record(request)?request:{},ref=reference(data.reservation);
    command(data.command);const tripId=id(data.trip_id);
    const prep=await this.preparation(ref.assignmentId);
    if(prep.state!=='PREPARED'||prep.trip_id!==tripId||prep.booking_id!==ref.bookingId)
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_PREPARATION_MISMATCH');
    return this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<Reservation[]>`
        SELECT * FROM driver_reservation WHERE assignment_id=${ref.assignmentId}::uuid FOR UPDATE`;
      const row=this.match(rows[0],ref);
      if(row.state==='BOUND'&&row.trip_id===tripId) return dto(row);
      if(row.state!=='HELD') throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      const changed=await tx.$queryRaw<Reservation[]>`
        UPDATE driver_reservation SET state='BOUND',trip_id=${tripId}::uuid,
          version=version+1,updated_at=now() WHERE reservation_id=${ref.reservationId}::uuid
            AND state='HELD' RETURNING *`;
      if(!changed[0]) throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      return dto(changed[0]);
    });
  }
  async cancel(request:unknown):Promise<Data> {
    const data=record(request)?request:{};command(data.command);
    const assignmentId=id(data.assignment_id),bookingId=id(data.booking_id),tripId=id(data.trip_id);
    const prep=await this.preparation(assignmentId);
    if(prep.state!=='PREPARATION_CANCELLED'||prep.trip_id!==tripId||prep.booking_id!==bookingId)
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_CANCELLED');
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${assignmentId}))`;
      const old=await tx.$queryRaw<Cancellation[]>`
        SELECT * FROM driver_reservation_cancellation WHERE assignment_id=${assignmentId}::uuid FOR UPDATE`;
      if(old[0]&&(old[0].booking_id!==bookingId||old[0].trip_id!==tripId))
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      const rows=await tx.$queryRaw<Reservation[]>`
        SELECT * FROM driver_reservation WHERE assignment_id=${assignmentId}::uuid FOR UPDATE`;
      if(rows[0]&&(rows[0].booking_id!==bookingId||
          rows[0].trip_id!==null&&rows[0].trip_id!==tripId))
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      if(!old[0]) await tx.$executeRaw`INSERT INTO driver_reservation_cancellation
        (assignment_id,booking_id,trip_id) VALUES
        (${assignmentId}::uuid,${bookingId}::uuid,${tripId}::uuid)`;
      if(rows[0]&&rows[0].state!=='RELEASED') await this.releaseLocal(tx,rows[0],false);
      const result=await tx.$queryRaw<Cancellation[]>`
        SELECT * FROM driver_reservation_cancellation WHERE assignment_id=${assignmentId}::uuid`;
      return {assignment_id:assignmentId,booking_id:bookingId,trip_id:tripId,
        cancelled_at:stamp(result[0]!.cancelled_at)};
    });
  }
  private async releaseLocal(tx:Tx,row:Reservation,blockVehicle:boolean):Promise<Reservation> {
    const changed=await tx.$queryRaw<Reservation[]>`
      UPDATE driver_reservation SET state='RELEASED',trip_id=NULL,version=version+1,
        updated_at=now() WHERE reservation_id=${row.reservation_id}::uuid
          AND state<>'RELEASED' RETURNING *`;
    if(!changed[0]) throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
    if(blockVehicle) await tx.$executeRaw`UPDATE vehicle SET vehicle_status='INACTIVE',
      version=version+1,updated_at=now() WHERE vehicle_id=${row.vehicle_id}::uuid`;
    await tx.$executeRaw`UPDATE driver_profile SET driver_status='OFFLINE',
      version=version+1,updated_at=now() WHERE driver_id=${row.driver_id}::uuid
        AND driver_status='BUSY'`;
    return changed[0];
  }
  async release(request:unknown):Promise<Data> {
    const data=record(request)?request:{},ref=reference(data.reservation);
    command(data.command);
    const tripId=data.trip_id===undefined?undefined:id(data.trip_id),
      operationId=data.closure_operation_id===undefined?undefined:id(data.closure_operation_id);
    if(Boolean(tripId)!==Boolean(operationId)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    let blockVehicle=false;
    if(tripId) {
      const closure=await this.owner(this.trip,this.tripDef,'GetClosureContext',
        {trip_id:tripId,closure_operation_id:operationId});
      const owned=record(closure.reservation)?closure.reservation:{};
      if(closure.trip_id!==tripId||closure.closure_operation_id!==operationId||
          owned.reservation_id!==ref.reservationId||owned.assignment_id!==ref.assignmentId||
          owned.booking_id!==ref.bookingId||owned.driver_id!==ref.driverId||
          owned.vehicle_id!==ref.vehicleId||String(owned.generation)!==ref.generation)
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      blockVehicle=closure.block_vehicle===true;
    } else {
      const prep=await this.preparation(ref.assignmentId);
      if(prep.state!=='PREPARATION_CANCELLED'||prep.booking_id!==ref.bookingId)
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_CANCELLED');
    }
    return this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<Reservation[]>`
        SELECT * FROM driver_reservation WHERE assignment_id=${ref.assignmentId}::uuid FOR UPDATE`;
      const row=this.match(rows[0],ref);
      if(row.state==='RELEASED') return dto(row);
      if(tripId ? row.state!=='BOUND'||row.trip_id!==tripId : row.state!=='HELD')
        throw fail(grpc.status.FAILED_PRECONDITION,'STALE_FENCE');
      return dto(await this.releaseLocal(tx,row,blockVehicle));
    });
  }
}
