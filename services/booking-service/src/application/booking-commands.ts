import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import type pg from 'pg';
import {BookingOwners,record,type Data} from '../infrastructure/owner-clients.js';
import {BookingLedger,fail,id} from './booking-ledger.js';

const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
const command=(operationId:string)=>({command_id:operationId,operation_id:operationId});
const stageCommand=(operationId:string,stage:string)=>{
  const bytes=createHash('sha256').update(`${operationId}:${stage}`).digest();
  bytes[6]=(bytes[6]!&0x0f)|0x50;bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=bytes.subarray(0,16).toString('hex');
  const commandId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return {command_id:commandId,operation_id:operationId};
};
const positive=(value:unknown)=>typeof value==='string'&&/^[1-9]\d*$/.test(value);
const location=(value:unknown):value is Data=>record(value)&&record(value.point)&&
  typeof value.address==='string'&&value.address.trim().length>0&&
  typeof value.point.latitude==='number'&&Number.isFinite(value.point.latitude)&&
  Math.abs(value.point.latitude)<=90&&typeof value.point.longitude==='number'&&
  Number.isFinite(value.point.longitude)&&Math.abs(value.point.longitude)<=180;

export class BookingCommands {
  readonly owners=new BookingOwners();
  readonly ledger:BookingLedger;
  constructor(db:pg.Pool) {
    const file=process.env.CAB_BOOKING_CURSOR_KEY_FILE;
    if(!file) throw new Error('Booking cursor key configuration missing');
    let key:Buffer;try {key=Buffer.from(readFileSync(file,'utf8').trim(),'base64url');}
    catch {throw new Error('Booking cursor key unavailable');}
    if(key.length!==32) throw new Error('Booking cursor key invalid');
    this.ledger=new BookingLedger(db,key);
  }
  close():void {this.owners.close();}
  private async user(metadata:grpc.Metadata,roles:string[]) {
    return this.owners.principal(metadata,roles);
  }
  private async owned(bookingId:string,metadata:grpc.Metadata) {
    const principal=await this.user(metadata,['CUSTOMER','OPERATOR']);
    const row=await this.ledger.booking(bookingId);
    if(!row||principal.role==='CUSTOMER'&&
        (row.customer_account_id!==principal.accountId||row.customer_id!==principal.customerId))
      throw fail(grpc.status.NOT_FOUND,'BOOKING_NOT_FOUND');
    return {row,principal};
  }
  async create(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};
    const principal=await this.user(metadata,['CUSTOMER']);
    if(!principal.customerId||input.vehicle_type!=='MOTORBIKE'||
        !location(input.pickup)||!location(input.destination)||
        (input.pickup.point as Data).latitude===(input.destination.point as Data).latitude&&
        (input.pickup.point as Data).longitude===(input.destination.point as Data).longitude||
        input.note!==undefined&&(typeof input.note!=='string'||input.note.length>500))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const accepted={pickup:input.pickup,destination:input.destination,
      vehicle_type:'MOTORBIKE',
      ...(input.note?{note:input.note}:{})};
    const operation=await this.ledger.createOperation(principal.customerId,
      principal.accountId,accepted);
    await this.resumeCreate(operation.operation_id);
    const latest=await this.ledger.operation(operation.operation_id);
    if(latest?.state==='SUCCEEDED') {
      // The immutable creation snapshot stays PENDING. Advance only this Booking's
      // dispatch after commit so the initial offer can be observed by the caller.
      try {await this.processOneDispatch(latest.booking_id);}
      catch { /* The durable worker will resume; a committed Booking remains valid. */ }
      const dispatch=await this.ledger.dispatch(latest.booking_id);
      const pending=await this.ledger.pendingOffer(latest.booking_id);
      const current=await this.ledger.booking(latest.booking_id);
      return {status:'SUCCEEDED',operation:this.ledger.operationDto(latest),
        booking:latest.response_snapshot,
        dispatch_status:dispatch?.status??'QUEUED',
        ...(pending&&pending.expires_at>new Date()&&current?
          {initial_offer:this.ledger.offerDto(pending,current)}:{})};
    }
    if(latest?.state==='FAILED') return {status:'FAILED',
      operation:this.ledger.operationDto(latest)};
    return {status:'PROCESSING',operation:this.ledger.operationDto(operation)};
  }
  async resumeCreate(operationId:string):Promise<void> {
    const operation=await this.ledger.operation(operationId);
    if(!operation||operation.state!=='PROCESSING') return;
    if(operation.error_code) {
      try {await this.owners.call('customer','CancelBookingGuard',{
        command:command(operation.operation_id),booking_id:operation.booking_id,
        customer_id:operation.customer_id});
        await this.ledger.finishFailedCreate(operationId);
      } catch {return;}return;
    }
    let stage='customer-guard';
    try {
      if(!operation.guard_ref) {
        const guard=await this.owners.call('customer','AcquireGuard',{
          command:command(operation.operation_id),customer_id:operation.customer_id,
          booking_id:operation.booking_id});
        if(guard.state!=='BOOKING_HELD'||!record(guard.guard)||
            guard.guard.booking_id!==operation.booking_id||
            guard.guard.customer_id!==operation.customer_id)
          throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
        await this.ledger.saveGuard(operationId,guard.guard);
      }
      if(!operation.pricing_snapshot) {
        stage='pricing-snapshot';
        const request=operation.request_snapshot;
        const pricing=await this.owners.call('payment','GetPricingSnapshot',{
          operation_id:operationId,vehicle_type:'MOTORBIKE',
          booking_accepted_at:stamp(operation.accepted_at),pickup:request.pickup,
          destination:request.destination});
        if(pricing.vehicle_type!=='MOTORBIKE'||pricing.currency!=='VND'||
            !positive(pricing.total_amount)||!positive(pricing.distance_meters)||
            typeof pricing.pricing_version_id!=='string'||!pricing.pricing_version_id)
          throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
        await this.ledger.savePricing(operationId,pricing);
      }
      stage='booking-commit';
      await this.ledger.finishCreate(operationId);
    } catch(error) {
      const code=(error as grpc.ServiceError).code;
      console.warn(`booking create deferred at ${stage}; category=${typeof code==='number'?code:'internal'}`);
      if(code===grpc.status.FAILED_PRECONDITION||code===grpc.status.INVALID_ARGUMENT||
          code===grpc.status.ALREADY_EXISTS) {
        // A durable failure first changes the owner decision to RELEASE. The
        // Customer tombstone is confirmed before exposing a terminal result.
        await this.ledger.abandonCreate(operationId,
          code===grpc.status.ALREADY_EXISTS?'ACTIVE_BOOKING_OR_TRIP_EXISTS':
            code===grpc.status.INVALID_ARGUMENT?'VALIDATION_ERROR':'INVALID_ROUTE',
          code===grpc.status.ALREADY_EXISTS?409:400);
        await this.resumeCreate(operationId);
      }
    }
  }
  async operation(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const operationId=id(record(request)?request.operation_id:undefined);
    const principal=await this.user(metadata,['CUSTOMER','OPERATOR']);
    const row=await this.ledger.operation(operationId);
    if(!row||principal.role==='CUSTOMER'&&row.customer_account_id!==principal.accountId)
      throw fail(grpc.status.NOT_FOUND,'OPERATION_NOT_FOUND');
    return this.ledger.operationDto(row);
  }
  async get(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const bookingId=id(record(request)?request.booking_id:undefined);
    const {row}=await this.owned(bookingId,metadata);
    return this.ledger.bookingDto(row);
  }
  async list(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};
    const principal=await this.user(metadata,['CUSTOMER']);
    if(!principal.customerId) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const limit=Number(input.limit||20);
    return this.ledger.list(principal.accountId,principal.customerId,
      input.booking_status===undefined?undefined:String(input.booking_status),limit,
      typeof input.cursor==='string'?input.cursor:undefined);
  }
  async status(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const bookingId=id(record(request)?request.booking_id:undefined);
    const {row}=await this.owned(bookingId,metadata);
    return {booking_id:bookingId,booking_status:row.status,
      ...(row.trip_id?{trip_id:row.trip_id}:{}),updated_at:stamp(row.updated_at)};
  }
  async cancel(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{},bookingId=id(input.booking_id);
    if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    await this.owned(bookingId,metadata);
    const principal=await this.user(metadata,['CUSTOMER','OPERATOR']);
    const operation=await this.ledger.requestCancel(bookingId,input.reason,principal.accountId);
    await this.resumeCancel(operation.operation_id);
    const latest=await this.ledger.operation(operation.operation_id);
    if(latest?.state==='SUCCEEDED') return {status:'SUCCEEDED',
      operation:this.ledger.operationDto(latest),booking:latest.response_snapshot};
    if(latest?.state==='FAILED') return {status:'FAILED',
      operation:this.ledger.operationDto(latest)};
    return {status:'PROCESSING',operation:this.ledger.operationDto(operation)};
  }
  async resumeCancel(operationId:string):Promise<void> {
    const operation=await this.ledger.operation(operationId);
    if(!operation||operation.operation_type!=='CANCEL_BOOKING'||
        operation.state!=='PROCESSING') return;
    let assignment=await this.ledger.assignmentByBooking(operation.booking_id);
    if(assignment&&assignment.state!=='COMPENSATED') {
      let preparation:Data|undefined;
      try {preparation=await this.owners.call('trip','GetTripPreparation',
        {assignment_id:assignment.assignment_id});}
      catch(error) {if((error as grpc.ServiceError).code!==grpc.status.NOT_FOUND) return;}
      if(preparation?.state==='ACTIVE'||assignment.state==='ASSIGNED') {
        await this.ledger.cancelLost(operation.booking_id);
        await this.resumeAssignment(assignment.assignment_id);return;
      }
      await this.ledger.beginCancelCompensation(assignment.assignment_id);
      await this.compensate(assignment.assignment_id);
      assignment=await this.ledger.assignmentByBooking(operation.booking_id);
      if(assignment) return;
    }
    const booking=await this.ledger.booking(operation.booking_id);
    if(!booking) return;
    try {const fenced=await this.owners.call('customer','CancelBookingGuard',{
      command:command(booking.create_operation_id),booking_id:operation.booking_id,
      customer_id:operation.customer_id});
      if(fenced.booking_id!==operation.booking_id) return;
      await this.ledger.finishCancelled(operationId);
    } catch { /* Retain PROCESSING for durable retry. */ }
  }
  async dispatchStatus(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const bookingId=id(record(request)?request.booking_id:undefined);
    await this.owned(bookingId,metadata);
    const process=await this.ledger.dispatch(bookingId);
    if(!process) throw fail(grpc.status.NOT_FOUND,'DISPATCH_NOT_FOUND');
    const assignment=await this.ledger.assignmentByBooking(bookingId);
    return this.ledger.dispatchDto(process,assignment);
  }
  async driverOffers(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const principal=await this.user(metadata,['DRIVER']);
    if(!principal.driverId) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const input=record(request)?request:{};
    return this.ledger.offersForDriver(principal.driverId,Number(input.limit||20),
      typeof input.cursor==='string'?input.cursor:undefined);
  }
  async driverOffer(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const offerId=id(record(request)?request.trip_request_id:undefined);
    const principal=await this.user(metadata,['DRIVER']);
    const offer=await this.ledger.offer(offerId);
    if(!offer||offer.driver_id!==principal.driverId||
        offer.driver_account_id!==principal.accountId)
      throw fail(grpc.status.NOT_FOUND,'TRIP_REQUEST_NOT_FOUND');
    const booking=await this.ledger.booking(offer.booking_id);
    if(!booking) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return this.ledger.offerDto(offer,booking);
  }
  async reject(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};const offerId=id(input.trip_request_id);
    const principal=await this.user(metadata,['DRIVER']);
    if(!principal.driverId) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const reason=input.reason;
    if(reason!==undefined&&(typeof reason!=='string'||!reason.trim()||reason.length>500))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const offer=await this.ledger.rejectOffer(offerId,principal.driverId,
      typeof reason==='string'?reason:undefined);
    const booking=await this.ledger.booking(offer.booking_id);
    if(!booking) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return this.ledger.offerDto(offer,booking);
  }
  async assignmentOperation(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const assignmentId=id(record(request)?request.operation_id:undefined);
    const principal=await this.user(metadata,['DRIVER']);
    const assignment=await this.ledger.assignment(assignmentId);
    if(!assignment||assignment.driver_id!==principal.driverId||
        (assignment.parties as Data).driver_account_id!==principal.accountId)
      throw fail(grpc.status.NOT_FOUND,'OPERATION_NOT_FOUND');
    const offer=await this.ledger.offer(assignment.trip_request_id);
    const booking=await this.ledger.booking(assignment.booking_id);
    if(!offer||!booking) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    const status=assignment.state==='ASSIGNED'?'SUCCEEDED':
      assignment.state==='COMPENSATED'?'FAILED':'PROCESSING';
    return {operation_id:assignmentId,trip_request_id:assignment.trip_request_id,status,
      created_at:stamp(assignment.claimed_at),updated_at:stamp(assignment.updated_at),
      ...(status==='SUCCEEDED'?{result:this.ledger.offerDto(offer,booking)}:{})};
  }
  async accept(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const offerId=id(record(request)?request.trip_request_id:undefined);
    const principal=await this.user(metadata,['DRIVER']);
    if(!principal.driverId) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const assignment=await this.ledger.claimOffer(offerId,principal.driverId,principal.accountId);
    await this.resumeAssignment(assignment.assignment_id);
    const booking=await this.ledger.booking(assignment.booking_id);
    const offer=await this.ledger.offer(offerId);
    if(!booking||!offer) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    const latest=await this.ledger.assignment(assignment.assignment_id);
    if(latest?.state==='ASSIGNED'&&booking.status==='DRIVER_ASSIGNED')
      return {status:'SUCCEEDED',offer:this.ledger.offerDto(offer,booking),
        booking:this.ledger.bookingDto(booking),operation_id:assignment.assignment_id};
    if(latest?.state==='COMPENSATED')
      throw fail(grpc.status.FAILED_PRECONDITION,'DRIVER_NOT_AVAILABLE');
    return {status:'PROCESSING',operation_id:assignment.assignment_id};
  }
  async resumeAssignment(assignmentId:string):Promise<void> {
    let assignment=await this.ledger.assignment(assignmentId);
    if(!assignment||['ASSIGNED','COMPENSATED'].includes(assignment.state)) return;
    if(assignment.state==='COMPENSATING') return this.compensate(assignmentId);
    const offer=await this.ledger.offer(assignment.trip_request_id);
    if(!offer) return;
    try {
      if(assignment.state==='CLAIMED') {
        const reservation=await this.owners.call('driver','ReserveDriver',{
          command:stageCommand(assignmentId,'reserve'),assignment_id:assignmentId,
          booking_id:assignment.booking_id,driver_id:assignment.driver_id,
          vehicle_id:assignment.vehicle_id,vehicle_type:'MOTORBIKE',
          expected_driver_version:String(offer.expected_driver_version),
          expected_vehicle_version:String(offer.expected_vehicle_version)});
        if(reservation.state!=='HELD'||!record(reservation.reservation)||
            reservation.reservation.assignment_id!==assignmentId)
          throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
        await this.ledger.saveReservation(assignmentId,reservation.reservation);
        await this.ledger.advanceAssignment(assignmentId,'CLAIMED','PREPARING');
      }
      assignment=await this.ledger.assignment(assignmentId);if(!assignment) return;
      if(assignment.state==='PREPARING') {
        if(!assignment.reservation_ref) return;
        const prepared=await this.owners.call('trip','PrepareTrip',{
          command:stageCommand(assignmentId,'prepare'),assignment_id:assignmentId,trip_id:assignment.trip_id,
          booking_id:assignment.booking_id,parties:assignment.parties,guard:assignment.guard_ref,
          reservation:assignment.reservation_ref,pickup:assignment.pickup,
          destination:assignment.destination,pricing:assignment.pricing});
        if(prepared.state!=='PREPARED'&&prepared.state!=='ACTIVE')
          throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_PREPARATION_FAILED');
        await this.owners.call('customer','BindGuard',{
          command:stageCommand(assignmentId,'bind-guard'),guard:assignment.guard_ref,
          trip_id:assignment.trip_id,assignment_id:assignmentId});
        await this.owners.call('driver','BindReservation',{
          command:stageCommand(assignmentId,'bind-reservation'),reservation:assignment.reservation_ref,
          trip_id:assignment.trip_id});
        await this.ledger.advanceAssignment(assignmentId,'PREPARING','ACTIVATING');
      }
      assignment=await this.ledger.assignment(assignmentId);if(!assignment) return;
      if(assignment.state==='ACTIVATING') {
        const prepared=await this.owners.call('trip','GetTripPreparation',
          {assignment_id:assignmentId});
        const active=prepared.state==='ACTIVE'?prepared:await this.owners.call('trip','ActivateTrip',{
          command:stageCommand(assignmentId,'activate'),assignment_id:assignmentId,
          expected_version:String(prepared.version)});
        if(active.state!=='ACTIVE') throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
        await this.ledger.completeAssignment(assignmentId);
      }
    } catch(error) {
      const code=(error as grpc.ServiceError).code;
      if(code===grpc.status.FAILED_PRECONDITION||code===grpc.status.ALREADY_EXISTS) {
        await this.ledger.markCompensating(assignmentId,'ASSIGNMENT_FAILED');
        await this.compensate(assignmentId);
      }
    }
  }
  private async compensate(assignmentId:string):Promise<void> {
    const assignment=await this.ledger.assignment(assignmentId);
    if(!assignment||assignment.state!=='COMPENSATING') return;
    try {
      const cancelled=await this.owners.call('trip','CancelTripPreparation',{
        command:stageCommand(assignmentId,'cancel-trip-preparation'),assignment_id:assignmentId,
        trip_id:assignment.trip_id,booking_id:assignment.booking_id});
      if(cancelled.state!=='PREPARATION_CANCELLED') return;
      await this.owners.call('driver','CancelReservation',{
        command:stageCommand(assignmentId,'cancel-reservation'),assignment_id:assignmentId,
        booking_id:assignment.booking_id,trip_id:assignment.trip_id});
      await this.owners.call('customer','RestoreBookingGuard',{
        command:stageCommand(assignmentId,'restore-guard'),guard:assignment.guard_ref,
        trip_id:assignment.trip_id,assignment_id:assignmentId});
      await this.ledger.completeCompensation(assignmentId);
    } catch { /* The durable COMPENSATING row is retried by the worker. */ }
  }
  async assignmentDecision(request:unknown):Promise<Data> {
    const assignmentId=id(record(request)?request.assignment_id:undefined);
    const assignment=await this.ledger.assignment(assignmentId);
    if(!assignment) throw fail(grpc.status.NOT_FOUND,'ASSIGNMENT_NOT_FOUND');
    return this.ledger.assignmentDto(assignment);
  }
  async guardDecision(request:unknown):Promise<Data> {
    return this.ledger.guardDecision(id(record(request)?request.id:undefined));
  }
  async paymentContext(request:unknown):Promise<Data> {
    return this.ledger.paymentContext(id(record(request)?request.trip_id:undefined));
  }
  async tickDispatch():Promise<void> {
    for(const operationId of await this.ledger.processingCreates())
      await this.resumeCreate(operationId);
    for(const assignmentId of await this.ledger.pendingAssignments())
      await this.resumeAssignment(assignmentId);
    for(const operationId of await this.ledger.processingCancels())
      await this.resumeCancel(operationId);
    for(const bookingId of await this.ledger.pendingDispatchIds())
      await this.processOneDispatch(bookingId);
  }
  private async processOneDispatch(bookingId:string):Promise<void> {
      const booking=await this.ledger.booking(bookingId);
      if(!booking) return;
      const process=await this.ledger.startDispatch(bookingId);
      if(!process||process.status!=='SEARCHING') return;
      const offer=await this.ledger.pendingOffer(bookingId);
      if(offer) {
        if(offer.expires_at<=new Date())
          await this.ledger.expireOffer(offer.trip_request_id,'RESPONSE_TIMEOUT');
        else return;
      }
      const latest=await this.ledger.dispatch(bookingId);
      if(!latest||latest.status!=='SEARCHING') return;
      if(latest.deadline_at<=new Date()||latest.attempt_count>=latest.max_offers) {
        const reason=latest.deadline_at<=new Date()?'SEARCH_TIMEOUT':'OFFER_LIMIT_REACHED';
        if(await this.ledger.noDriver(bookingId,reason)) {
          const operation=await this.ledger.operation(booking.create_operation_id);
          if(operation) {
            const released=await this.owners.call('customer','CancelBookingGuard',{
              command:command(operation.operation_id),booking_id:bookingId,
              customer_id:booking.customer_id});
            if(released.booking_id===bookingId) await this.ledger.finishNoDriver(bookingId);
          }
        }
        return;
      }
      const candidates=await this.owners.call('driver','FindDispatchCandidates',{
        booking_id:bookingId,pickup:(booking.pickup as Data).point,
        vehicle_type:'MOTORBIKE',radius_meters:1000,limit:10,
        excluded_driver_ids:latest.attempted_driver_ids});
      if(!Array.isArray(candidates.candidates)) return;
      for(const candidate of candidates.candidates) {
        if(!record(candidate)) continue;
        const issued=await this.ledger.issueOffer(bookingId,candidate);
        if(issued) break;
      }
  }
}
