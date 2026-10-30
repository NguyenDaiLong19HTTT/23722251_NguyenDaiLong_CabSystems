import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import type pg from 'pg';
import {OwnerClients} from '../infrastructure/owner-clients.js';
import {TripLedger,fail,id,record,version,type Data} from './trip-ledger.js';

const text=(value:unknown)=>typeof value==='string'?value:'';
export class TripCommands {
  readonly ledger:TripLedger;
  readonly owners:OwnerClients;
  constructor(db:pg.Pool) {
    const file=process.env.CAB_TRIP_CURSOR_KEY_FILE;
    if(!file) throw new Error('Trip cursor key configuration missing');
    let key:Buffer;
    try {key=Buffer.from(readFileSync(file,'utf8').trim(),'base64url');}
    catch {throw new Error('Trip cursor key unavailable');}
    if(key.length!==32) throw new Error('Trip cursor key invalid');
    this.ledger=new TripLedger(db,key);this.owners=new OwnerClients();
  }
  close():void {this.owners.close();}
  async prepare(request:unknown):Promise<Data> {
    const input=record(request)?request:{};
    id(input.assignment_id);id(input.trip_id);id(input.booking_id);
    const replay=await this.ledger.prepareReplay(input);if(replay) return replay;
    await this.owners.verifyPreparation(input,'PREPARING');
    return this.ledger.prepare(input);
  }
  async getPreparation(request:unknown):Promise<Data> {return this.ledger.preparation(
    id(record(request)?request.assignment_id:undefined));}
  async activate(request:unknown):Promise<Data> {
    const input=record(request)?request:{};
    const assignmentId=id(input.assignment_id),expected=version(input.expected_version);
    const commandId=id(record(input.command)?input.command.command_id:undefined);
    const previous=await this.ledger.preparation(assignmentId);
    const replay=await this.ledger.activateReplay(assignmentId,commandId,expected,
      String(previous.trip_id));if(replay) return replay;
    if(previous.state==='ACTIVE') return previous;
    if(previous.state!=='PREPARED')
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_PREPARATION_CANCELLED');
    const snapshot=await this.ledger.preparationSnapshot(assignmentId);
    await this.owners.verifyPreparation(snapshot,'ACTIVATING');
    return this.ledger.activate(assignmentId,expected,commandId);
  }
  async cancelPreparation(request:unknown):Promise<Data> {
    const input=record(request)?request:{};
    if(!record(input.command)||!text(input.command.command_id))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const replay=await this.ledger.cancelPreparationReplay(input);if(replay) return replay;
    return this.ledger.cancelPreparation(input);
  }
  async principalTrip(request:unknown,metadata:grpc.Metadata,
    action:'READ'|'DRIVER'|'CUSTOMER'|'OPERATOR'='READ') {
    const tripId=id(record(request)?request.trip_id:undefined);
    const principal=await this.owners.principal(metadata);
    const trip=await this.ledger.find(tripId);
    if(!trip) throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
    if(action==='DRIVER'&&principal.role!=='DRIVER'||
        action==='CUSTOMER'&&principal.role!=='CUSTOMER'||
        action==='OPERATOR'&&principal.role!=='OPERATOR')
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    if(principal.role==='CUSTOMER'&&
        (principal.customerId!==trip.customer_id||principal.accountId!==trip.customer_account_id)||
       principal.role==='DRIVER'&&
        (principal.driverId!==trip.driver_id||principal.accountId!==trip.driver_account_id))
      throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
    return {tripId,trip,principal};
  }
  async getTrip(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const {tripId}=await this.principalTrip(request,metadata);
    return this.ledger.view(tripId);
  }
  async tracking(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const {tripId,trip,principal}=await this.principalTrip(request,metadata);
    if(!['CUSTOMER','OPERATOR'].includes(principal.role))
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const token=this.owners.token(metadata);
    const [contact,vehicle]=await Promise.all([
      this.owners.trackingDriver(tripId,trip.driver_account_id,token),
      this.owners.trackingVehicle(tripId,trip.driver_id,trip.vehicle_id,token)]);
    const latest=await this.principalTrip(request,metadata);
    if(!['CUSTOMER','OPERATOR'].includes(latest.principal.role))
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const now=new Date(),closed=Boolean(latest.trip.closed_at);
    const point=closed?undefined:await this.ledger.trackingPoint(tripId);
    const final=await this.principalTrip(request,metadata);
    if(final.trip.version!==latest.trip.version||
        Boolean(final.trip.closed_at)!==closed)
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    const stopped=Boolean(final.trip.closed_at);
    const live=point&&now.getTime()-point.recorded_at.getTime()<=30000;
    return {trip_id:tripId,trip_status:final.trip.status,trip_version:final.trip.version,
      driver:{driver_id:final.trip.driver_id,full_name:contact.full_name,
        ...(!stopped&&typeof contact.phone==='string'?{phone:contact.phone}:{})},
      vehicle:{vehicle_id:final.trip.vehicle_id,license_plate:vehicle.plate_number,
        vehicle_type:vehicle.vehicle_type},
      tracking_status:stopped?'STOPPED':!point?'UNAVAILABLE':live?'LIVE':'STALE',
      ...(stopped?{}:point?{driver_location:{latitude:point.latitude,
        longitude:point.longitude,recorded_at:{seconds:String(Math.floor(point.recorded_at.getTime()/1000)),nanos:(point.recorded_at.getTime()%1000)*1e6},
        received_at:{seconds:String(Math.floor(point.received_at.getTime()/1000)),nanos:(point.received_at.getTime()%1000)*1e6}}}:{}),
      eta_status:stopped?'NOT_APPLICABLE':final.trip.status==='DRIVER_ASSIGNED'?'UNAVAILABLE':'NOT_APPLICABLE',
      ...(stopped?{closed_at:{seconds:String(Math.floor(final.trip.closed_at!.getTime()/1000)),nanos:0}}:{}),
      snapshot_at:{seconds:String(Math.floor(now.getTime()/1000)),nanos:(now.getTime()%1000)*1e6}};
  }
  async list(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};const principal=await this.owners.principal(metadata);
    if(!['CUSTOMER','DRIVER'].includes(principal.role))
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const status=input.trip_status;
    if(status!==undefined&&!['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS',
      'COMPLETED','CANCELLED','ERROR'].includes(String(status)))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const date=(value:unknown)=>{if(value===undefined) return;
      if(!record(value)||!/^\d+$/.test(String(value.seconds))||
          !Number.isInteger(value.nanos)||Number(value.nanos)<0||Number(value.nanos)>=1e9)
        throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
      const parsed=new Date(Number(value.seconds)*1000+Math.floor(Number(value.nanos)/1e6));
      if(!Number.isFinite(parsed.getTime())) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
      return parsed;};
    const from=date(input.from),to=date(input.to);
    if(from&&to&&from>=to) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const limit=Number(input.limit??20);
    if(!Number.isInteger(limit)||limit<1||limit>100)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return this.ledger.list(principal,{status:status===undefined?undefined:String(status),
      from,to,limit,cursor:typeof input.cursor==='string'?input.cursor:undefined});
  }
  async status(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};
    const {tripId,trip,principal}=await this.principalTrip(input,metadata,'DRIVER');
    const expected=version(input.expected_version),next=text(input.trip_status);
    const commandId=id(input.command_id);
    if(!['ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS','COMPLETED'].includes(next))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const replay=await this.ledger.statusReplay(commandId,tripId,expected,next,principal.accountId);
    if(replay) return replay;
    if(trip.driver_account_id!==principal.accountId) throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
    return this.ledger.transition({tripId,commandId,expected,next,
      accountId:principal.accountId});
  }
  async cancel(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};
    const {tripId,principal}=await this.principalTrip(input,metadata);
    const expected=version(input.expected_version),commandId=id(input.command_id);
    const code=text(input.reason_code),reason=text(input.reason);
    if(!['CHANGE_OF_PLANS','VEHICLE_ISSUE','NO_SHOW','OTHER'].includes(code)||
        !reason.trim()) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    if(code==='CHANGE_OF_PLANS'&&principal.role!=='CUSTOMER'||
        code==='VEHICLE_ISSUE'&&!['DRIVER','OPERATOR'].includes(principal.role)||
        code==='NO_SHOW'&&principal.role!=='DRIVER')
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    return this.ledger.cancel({tripId,commandId,expected,reasonCode:code,reason,
      accountId:principal.accountId,role:principal.role});
  }
  async incident(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};
    const {tripId,principal}=await this.principalTrip(input,metadata,'DRIVER');
    const expected=version(input.expected_version),commandId=id(input.command_id);
    const issueType=text(input.issue_type),description=text(input.description).trim();
    if(!['VEHICLE_BREAKDOWN','ACCIDENT','PASSENGER_ISSUE','OTHER'].includes(issueType)||
        !description||description.length>2000)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return this.ledger.incident({tripId,commandId,expected,issueType,description,
      accountId:principal.accountId});
  }
  async resolveError(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};
    const {tripId,trip,principal}=await this.principalTrip(input,metadata,'OPERATOR');
    const expected=version(input.expected_trip_version);
    const action=text(input.resolution_action),note=text(input.resolution_note).trim();
    if(!['RESTORE_PREVIOUS_STATUS','CLOSE_ABNORMALLY'].includes(action)||
        !note||note.length>2000)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    // API07 does not require a client idempotency header. A canonical request produces
    // the same internal command ID on a retry, while a changed request cannot replay.
    const bytes=createHash('sha256').update(JSON.stringify([
      tripId,expected,action,note,principal.accountId])).digest();
    bytes[6]=(bytes[6]!&0x0f)|0x40;bytes[8]=(bytes[8]!&0x3f)|0x80;
    const hex=bytes.subarray(0,16).toString('hex');
    const commandId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const command={tripId,commandId,expected,action,note,accountId:principal.accountId};
    const replay=await this.ledger.resolveReplay(command);if(replay) return replay;
    let eligibilityCheckedAt:number|undefined;
    if(action==='RESTORE_PREVIOUS_STATUS') {
      try {eligibilityCheckedAt=await this.owners.verifyRestore(trip as unknown as Data);}
      catch(error) {
        if((error as grpc.ServiceError).code===grpc.status.FAILED_PRECONDITION)
          throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_RESOLVABLE');
        throw error;
      }
    }
    return this.ledger.resolveError({...command,eligibilityCheckedAt});
  }
  async closure(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const {tripId}=await this.principalTrip(request,metadata);
    return this.ledger.closure(tripId);
  }
  async internalClosure(request:unknown):Promise<Data> {
    const input=record(request)?request:{};const tripId=id(input.trip_id),operationId=id(input.closure_operation_id);
    const trip=await this.ledger.find(tripId);
    if(!trip||!trip.closed_at) throw fail(grpc.status.NOT_FOUND,'TRIP_CLOSURE_NOT_FOUND');
    const closure=await this.ledger.closure(tripId);
    if(closure.operation_id!==operationId) throw fail(grpc.status.NOT_FOUND,'TRIP_CLOSURE_NOT_FOUND');
    return {trip_id:tripId,closure_operation_id:operationId,closed_at:{
      seconds:String(Math.floor(trip.closed_at.getTime()/1000)),nanos:0},
      status:trip.status,guard:trip.guard_ref,reservation:trip.reservation_ref,
      block_vehicle:record(trip.cancellation)&&trip.cancellation.reason_code==='VEHICLE_ISSUE'||
        trip.status==='ERROR'&&await this.ledger.hasBreakdownIncident(tripId),
      trip_version:trip.version};
  }
  async paymentContext(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const {tripId,trip}=await this.principalTrip(request,metadata);
    return {trip_id:tripId,trip_version:trip.version,trip_status:trip.status,
      parties:{customer_id:trip.customer_id,customer_account_id:trip.customer_account_id,
        driver_id:trip.driver_id,driver_account_id:trip.driver_account_id,vehicle_id:trip.vehicle_id},
      ...(trip.completed_at?{completed_at:{seconds:String(Math.floor(trip.completed_at.getTime()/1000)),
        nanos:0}}:{})};
  }
  async ratingContext(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const {tripId,trip}=await this.principalTrip(request,metadata);
    return {trip_id:tripId,trip_version:trip.version,customer_id:trip.customer_id,
      driver_id:trip.driver_id,trip_status:trip.status,
      ...(trip.completed_at?{completed_at:{seconds:String(Math.floor(trip.completed_at.getTime()/1000)),
        nanos:0}}:{})};
  }
  async customerDriverRelation(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const accountId=id(record(request)?request.driver_account_id:undefined);
    const principal=await this.owners.principal(metadata);
    if(principal.role!=='CUSTOMER'||!principal.customerId)
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    return {related:await this.ledger.hasCustomerDriverTrip(principal.customerId,
      principal.accountId,accountId)};
  }
  async contactContext(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const {tripId,trip}=await this.principalTrip(request,metadata);
    return {trip_id:tripId,trip_version:trip.version,trip_status:trip.status,
      closed:Boolean(trip.closed_at),parties:{customer_id:trip.customer_id,
        customer_account_id:trip.customer_account_id,driver_id:trip.driver_id,
        driver_account_id:trip.driver_account_id,vehicle_id:trip.vehicle_id}};
  }
  async fareContext():Promise<Data> {throw fail(grpc.status.FAILED_PRECONDITION,'METRICS_NOT_CONFIRMED');}
  async recordAssignedLocation(request:unknown):Promise<Data> {
    return this.ledger.recordAssignedLocation(record(request)?request:{});
  }
}
