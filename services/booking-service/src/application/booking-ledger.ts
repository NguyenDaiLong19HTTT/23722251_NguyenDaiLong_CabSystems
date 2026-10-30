import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import * as grpc from '@grpc/grpc-js';
import {facadeError} from '@cab/grpc-transport';
import type pg from 'pg';
import {record,type Data} from '../infrastructure/owner-clients.js';

export const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
export const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const id=(value:unknown)=>{if(typeof value!=='string'||!uuid.test(value))
  throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');return value;};
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
type Operation={operation_id:string;operation_type:string;booking_id:string;customer_id:string;
  customer_account_id:string;state:string;guard_disposition:string;request_snapshot:Data;
  guard_ref:Data|null;pricing_snapshot:Data|null;response_snapshot:Data|null;
  error_code:string|null;failure_http_status:number|null;accepted_at:Date;created_at:Date;
  updated_at:Date};
type Booking={booking_id:string;create_operation_id:string;customer_id:string;
  customer_account_id:string;pickup:Data;destination:Data;vehicle_type:string;note:string|null;
  status:string;pricing_operation_id:string;pricing_snapshot:Data;guard_ref:Data;
  driver_id:string|null;driver_account_id:string|null;trip_id:string|null;
  cancellation:Data|null;version:bigint;created_at:Date;updated_at:Date};
type Dispatch={booking_id:string;status:string;attempt_count:number;
  attempted_driver_ids:string[];started_at:Date;deadline_at:Date;max_offers:number;
  offer_timeout_seconds:number;failure_reason:string|null;ended_at:Date|null;updated_at:Date};
type Offer={trip_request_id:string;booking_id:string;driver_id:string;
  driver_account_id:string;vehicle_id:string;expected_driver_version:bigint;
  expected_vehicle_version:bigint;status:string;sent_at:Date;expires_at:Date;
  resolved_at:Date|null;assignment_id:string|null;trip_id:string|null;
  reject_reason:string|null;closure_reason:string|null};
type Assignment={assignment_id:string;booking_id:string;trip_request_id:string;
  trip_id:string;state:string;customer_id:string;driver_id:string;vehicle_id:string;
  parties:Data;guard_ref:Data;reservation_ref:Data|null;pickup:Data;
  destination:Data;pricing:Data;claimed_at:Date;offer_expires_at:Date;
  dispatch_deadline_at:Date;cancel_requested:boolean;version:bigint;updated_at:Date};
type Cursor={a:string;c:string;s?:string;l:number;t:string;i:string;e:number};

export class BookingLedger {
  constructor(private readonly pool:pg.Pool,private readonly cursorKey:Buffer) {}
  private async transaction<T>(work:(db:pg.PoolClient)=>Promise<T>):Promise<T> {
    const db=await this.pool.connect();try {await db.query('BEGIN');const value=await work(db);
      await db.query('COMMIT');return value;}
    catch(error) {await db.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally {db.release();}
  }
  private cursor(value:Cursor):string {const body=Buffer.from(JSON.stringify(value)).toString('base64url');
    const mac=createHmac('sha256',this.cursorKey).update(body).digest('base64url');
    return `${body}.${mac}`;}
  private decode(value:string,accountId:string,customerId:string,status:string|undefined,
    limit:number):Cursor {
    if(value.length>1024||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(value))
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    const [body,mac]=value.split('.');
    const actual=createHmac('sha256',this.cursorKey).update(body!).digest();
    const supplied=Buffer.from(mac!,'base64url');
    if(actual.length!==supplied.length||!timingSafeEqual(actual,supplied))
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    let parsed:Cursor;try {parsed=JSON.parse(Buffer.from(body!,'base64url').toString('utf8'));}
    catch {throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');}
    if(parsed.a!==accountId||parsed.c!==customerId||parsed.s!==status||parsed.l!==limit||
        !uuid.test(parsed.i)||!Number.isFinite(Date.parse(parsed.t))||
        !Number.isSafeInteger(parsed.e)) throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    if(parsed.e<=Date.now()) throw fail(grpc.status.INVALID_ARGUMENT,'CURSOR_EXPIRED');
    return parsed;
  }
  operationDto(row:Operation):Data {return {operation_id:row.operation_id,
    operation_type:row.operation_type,status:row.state,
    ...(row.response_snapshot?{result:row.response_snapshot}:{}),
    ...(row.error_code?{error_code:row.error_code,failure_http_status:row.failure_http_status}:{}),
    created_at:stamp(row.created_at),updated_at:stamp(row.updated_at)};}
  bookingDto(row:Booking):Data {return {booking_id:row.booking_id,customer_id:row.customer_id,
    pickup:row.pickup,destination:row.destination,vehicle_type:row.vehicle_type,
    booking_status:row.status,pricing_version_id:row.pricing_snapshot.pricing_version_id,
    pricing_snapshot:row.pricing_snapshot,...(row.note?{note:row.note}:{}),
    ...(row.driver_id?{driver_id:row.driver_id}:{}),...(row.trip_id?{trip_id:row.trip_id}:{}),
    ...(row.cancellation?{cancellation:row.cancellation}:{}),
    created_at:stamp(row.created_at),updated_at:stamp(row.updated_at)};}
  offerDto(row:Offer,booking:Booking):Data {return {trip_request_id:row.trip_request_id,
    booking_id:row.booking_id,driver_id:row.driver_id,pickup:booking.pickup,
    destination:booking.destination,vehicle_type:booking.vehicle_type,
    ...(booking.note?{note:booking.note}:{}),status:row.status,
    sent_at:stamp(row.sent_at),expires_at:stamp(row.expires_at),
    ...(row.resolved_at?{resolved_at:stamp(row.resolved_at)}:{}),
    ...(row.status==='ACCEPTED'&&row.trip_id?{trip_id:row.trip_id}:{}),
    ...(row.reject_reason?{reject_reason:row.reject_reason}:{}),
    ...(row.closure_reason?{closure_reason:row.closure_reason}:{})};}
  async createOperation(customerId:string,accountId:string,request:Data):Promise<Operation> {
    return this.transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[customerId]);
      const active=await db.query(`SELECT 1 FROM booking_operation WHERE customer_id=$1
        AND operation_type='CREATE_BOOKING' AND state='PROCESSING'`,[customerId]);
      const booked=await db.query(`SELECT 1 FROM booking WHERE customer_id=$1
        AND status IN ('PENDING','FINDING_DRIVER')`,[customerId]);
      if(active.rowCount||booked.rowCount)
        throw fail(grpc.status.ALREADY_EXISTS,'ACTIVE_BOOKING_OR_TRIP_EXISTS');
      const operationId=randomUUID(),bookingId=randomUUID();
      const result=await db.query<Operation>(`INSERT INTO booking_operation
        (operation_id,operation_type,booking_id,customer_id,customer_account_id,state,
          guard_disposition,request_snapshot)
        VALUES($1,'CREATE_BOOKING',$2,$3,$4,'PROCESSING','KEEP_BOOKING_GUARD',$5::jsonb)
        RETURNING *`,[operationId,bookingId,customerId,accountId,JSON.stringify(request)]);
      return result.rows[0]!;
    });
  }
  async operation(operationId:string):Promise<Operation|undefined> {
    const result=await this.pool.query<Operation>('SELECT * FROM booking_operation WHERE operation_id=$1',
      [operationId]);return result.rows[0];}
  async guardDecision(bookingId:string):Promise<Data> {
    const result=await this.pool.query<Operation>(`SELECT * FROM booking_operation
      WHERE booking_id=$1 AND operation_type='CREATE_BOOKING'`,[bookingId]);
    const row=result.rows[0];if(!row) throw fail(grpc.status.NOT_FOUND,'BOOKING_NOT_FOUND');
    return {booking_id:bookingId,customer_id:row.customer_id,operation_id:row.operation_id,
      disposition:row.guard_disposition,version:'1'};
  }
  async saveGuard(operationId:string,guard:Data):Promise<void> {
    await this.pool.query(`UPDATE booking_operation SET guard_ref=$2::jsonb,updated_at=now()
      WHERE operation_id=$1 AND state='PROCESSING' AND guard_ref IS NULL`,
    [operationId,JSON.stringify(guard)]);
  }
  async savePricing(operationId:string,pricing:Data):Promise<void> {
    await this.pool.query(`UPDATE booking_operation SET pricing_snapshot=$2::jsonb,updated_at=now()
      WHERE operation_id=$1 AND state='PROCESSING' AND pricing_snapshot IS NULL`,
    [operationId,JSON.stringify(pricing)]);
  }
  async processingCreates(limit=10):Promise<string[]> {
    const rows=await this.pool.query<{operation_id:string}>(`SELECT operation_id
      FROM booking_operation WHERE operation_type='CREATE_BOOKING' AND state='PROCESSING'
      ORDER BY accepted_at LIMIT $1`,[limit]);return rows.rows.map(row=>row.operation_id);
  }
  async abandonCreate(operationId:string,reason:string,httpStatus:number):Promise<void> {
    await this.pool.query(`UPDATE booking_operation SET guard_disposition='RELEASE_BOOKING_GUARD',
      error_code=$2,failure_http_status=$3,updated_at=now()
      WHERE operation_id=$1 AND state='PROCESSING'`,[operationId,reason,httpStatus]);
  }
  async finishFailedCreate(operationId:string):Promise<void> {
    await this.pool.query(`UPDATE booking_operation SET state='FAILED',updated_at=now()
      WHERE operation_id=$1 AND state='PROCESSING' AND error_code IS NOT NULL`,[operationId]);
  }
  async finishCreate(operationId:string):Promise<Data> {
    return this.transaction(async db=>{
      const result=await db.query<Operation>(`SELECT * FROM booking_operation
        WHERE operation_id=$1 FOR UPDATE`,[operationId]);
      const operation=result.rows[0];if(!operation) throw fail(grpc.status.NOT_FOUND,'OPERATION_NOT_FOUND');
      if(operation.state==='SUCCEEDED') return operation.response_snapshot!;
      if(operation.state!=='PROCESSING'||!operation.guard_ref||!operation.pricing_snapshot)
        throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_NOT_READY');
      const request=operation.request_snapshot;
      const booked=await db.query<Booking>(`INSERT INTO booking
        (booking_id,create_operation_id,customer_id,customer_account_id,pickup,destination,
          vehicle_type,note,status,pricing_operation_id,pricing_snapshot,guard_ref)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'MOTORBIKE',$7,'PENDING',$2,$8::jsonb,$9::jsonb)
        RETURNING *`,[operation.booking_id,operationId,operation.customer_id,
        operation.customer_account_id,JSON.stringify(request.pickup),
        JSON.stringify(request.destination),request.note??null,
        JSON.stringify(operation.pricing_snapshot),JSON.stringify(operation.guard_ref)]);
      const booking=booked.rows[0]!,snapshot=this.bookingDto(booking);
      await db.query(`INSERT INTO booking_outbox
        (event_id,booking_id,aggregate_version,event_type,recipient_account_id,safe_payload)
        VALUES($1,$2,1,'BOOKING_RECEIVED',$3,'{}'::jsonb)`,[
        randomUUID(),booking.booking_id,booking.customer_account_id]);
      await db.query(`UPDATE booking_operation SET state='SUCCEEDED',response_snapshot=$2::jsonb,
        updated_at=now() WHERE operation_id=$1`,[operationId,JSON.stringify(snapshot)]);
      return snapshot;
    });
  }
  async booking(bookingId:string):Promise<Booking|undefined> {
    const result=await this.pool.query<Booking>('SELECT * FROM booking WHERE booking_id=$1',[bookingId]);
    return result.rows[0];}
  async list(accountId:string,customerId:string,status:string|undefined,limit:number,
    cursor?:string):Promise<Data> {
    if(!Number.isInteger(limit)||limit<1||limit>100||
        status!==undefined&&!['PENDING','FINDING_DRIVER','DRIVER_ASSIGNED','NO_DRIVER_FOUND','CANCELLED']
          .includes(status)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const after=cursor?this.decode(cursor,accountId,customerId,status,limit):undefined;
    const result=await this.pool.query<Booking>(`SELECT * FROM booking
      WHERE customer_account_id=$1 AND customer_id=$2 AND ($3::text IS NULL OR status=$3)
        AND ($4::timestamptz IS NULL OR (created_at,booking_id)<($4::timestamptz,$5::uuid))
      ORDER BY created_at DESC,booking_id DESC LIMIT $6`,[
      accountId,customerId,status??null,after?.t??null,after?.i??null,limit+1]);
    const rows=result.rows.slice(0,limit),hasMore=result.rows.length>limit;
    const items=rows.map(row=>({booking_id:row.booking_id,pickup:row.pickup,
      destination:row.destination,vehicle_type:row.vehicle_type,booking_status:row.status,
      created_at:stamp(row.created_at),updated_at:stamp(row.updated_at),
      ...(row.driver_id?{driver_id:row.driver_id}:{}),
      ...(row.trip_id?{trip_id:row.trip_id}:{})}));
    const last=rows.at(-1);
    return {items,limit,has_more:hasMore,
      ...(hasMore&&last?{next_cursor:this.cursor({a:accountId,c:customerId,s:status,l:limit,
        t:last.created_at.toISOString(),i:last.booking_id,e:Date.now()+15*60*1000})}:{})};
  }
  async startDispatch(bookingId:string):Promise<Dispatch|undefined> {
    return this.transaction(async db=>{
      const found=await db.query<Booking>('SELECT * FROM booking WHERE booking_id=$1 FOR UPDATE',
        [bookingId]);const booking=found.rows[0];
      if(!booking||!['PENDING','FINDING_DRIVER'].includes(booking.status)) return;
      const owner=await db.query<Operation>(`SELECT * FROM booking_operation
        WHERE operation_id=$1`,[booking.create_operation_id]);
      if(owner.rows[0]?.guard_disposition!=='KEEP_BOOKING_GUARD') return;
      const prior=await db.query<Dispatch>('SELECT * FROM booking_dispatch WHERE booking_id=$1',
        [bookingId]);
      if(prior.rows[0]) return prior.rows[0];
      const changed=await db.query<Booking>(`UPDATE booking SET status='FINDING_DRIVER',
        version=version+1,updated_at=now() WHERE booking_id=$1 AND status='PENDING' RETURNING *`,
      [bookingId]);
      if(!changed.rows[0]) return;
      const result=await db.query<Dispatch>(`INSERT INTO booking_dispatch
        (booking_id,status,deadline_at,max_offers,offer_timeout_seconds)
        VALUES($1,'SEARCHING',now()+interval '180 seconds',5,120) RETURNING *`,[bookingId]);
      return result.rows[0];
    });
  }
  async dispatch(bookingId:string):Promise<Dispatch|undefined> {
    const found=await this.pool.query<Dispatch>('SELECT * FROM booking_dispatch WHERE booking_id=$1',
      [bookingId]);return found.rows[0];}
  dispatchDto(row:Dispatch,assignment?:Assignment):Data {return {booking_id:row.booking_id,
    dispatch_status:row.status,attempt_count:row.attempt_count,started_at:stamp(row.started_at),
    deadline_at:stamp(row.deadline_at),config_snapshot:{search_radius_km:1,
      offer_timeout_seconds:row.offer_timeout_seconds,max_offers:row.max_offers,
      max_search_seconds:180,max_location_age_seconds:30},updated_at:stamp(row.updated_at),
    ...(row.ended_at?{ended_at:stamp(row.ended_at)}:{}),
    ...(row.failure_reason?{failure_reason:row.failure_reason}:{}),
    ...(assignment?.state==='ASSIGNED'?{driver_id:assignment.driver_id,
      trip_id:assignment.trip_id}:{})};}
  async pendingOffer(bookingId:string):Promise<Offer|undefined> {
    const found=await this.pool.query<Offer>(`SELECT * FROM booking_offer
      WHERE booking_id=$1 AND status='PENDING'`,[bookingId]);return found.rows[0];}
  async offer(offerId:string):Promise<Offer|undefined> {
    const found=await this.pool.query<Offer>(`SELECT * FROM booking_offer WHERE trip_request_id=$1`,
      [offerId]);return found.rows[0];}
  async pendingDispatchIds(limit=10):Promise<string[]> {
    const found=await this.pool.query<{booking_id:string}>(`SELECT b.booking_id FROM booking b
      JOIN booking_operation o ON o.operation_id=b.create_operation_id
      WHERE b.status IN ('PENDING','FINDING_DRIVER')
      AND o.guard_disposition='KEEP_BOOKING_GUARD'
      ORDER BY b.created_at LIMIT $1`,[limit]);
    return found.rows.map(row=>row.booking_id);
  }
  async issueOffer(bookingId:string,candidate:Data):Promise<Offer|undefined> {
    return this.transaction(async db=>{
      const found=await db.query<Booking>('SELECT * FROM booking WHERE booking_id=$1 FOR UPDATE',
        [bookingId]);const booking=found.rows[0];
      if(!booking) return;
      const owner=await db.query<Operation>(`SELECT * FROM booking_operation
        WHERE operation_id=$1`,[booking.create_operation_id]);
      if(owner.rows[0]?.guard_disposition!=='KEEP_BOOKING_GUARD') return;
      const processes=await db.query<Dispatch>(`SELECT * FROM booking_dispatch
        WHERE booking_id=$1 FOR UPDATE`,[bookingId]);const process=processes.rows[0];
      if(!booking||booking.status!=='FINDING_DRIVER'||!process||
          process.status!=='SEARCHING'||process.deadline_at<=new Date()||
          process.attempt_count>=process.max_offers) return;
      const existing=await db.query<Offer>(`SELECT * FROM booking_offer
        WHERE booking_id=$1 AND status='PENDING'`,[bookingId]);
      if(existing.rows[0]) return existing.rows[0];
      const driverId=id(candidate.driver_id),driverAccountId=id(candidate.driver_account_id),
        vehicleId=id(candidate.vehicle_id);
      if(process.attempted_driver_ids.includes(driverId)) return;
      const offerId=randomUUID();
      const created=await db.query<Offer>(`INSERT INTO booking_offer
        (trip_request_id,booking_id,driver_id,driver_account_id,vehicle_id,
          expected_driver_version,expected_vehicle_version,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',
          LEAST(now()+make_interval(secs=>$8::int),$9::timestamptz)) RETURNING *`,[
        offerId,bookingId,driverId,driverAccountId,vehicleId,
        candidate.driver_version,candidate.vehicle_version,process.offer_timeout_seconds,
        process.deadline_at]);
      await db.query(`UPDATE booking_dispatch SET attempt_count=attempt_count+1,
        attempted_driver_ids=attempted_driver_ids||$2::jsonb,updated_at=now()
        WHERE booking_id=$1`,[bookingId,JSON.stringify([driverId])]);
      await db.query(`INSERT INTO booking_outbox
        (event_id,booking_id,aggregate_version,event_type,recipient_account_id,safe_payload)
        VALUES($1,$2,$3,'TRIP_REQUEST_RECEIVED',$4,$5::jsonb)`,[
        randomUUID(),bookingId,1,driverAccountId,
        JSON.stringify({tripRequestId:offerId,
          expiresAt:created.rows[0]!.expires_at.toISOString()})]);
      return created.rows[0];
    });
  }
  async expireOffer(offerId:string,reason:'RESPONSE_TIMEOUT'|'SEARCH_TIMEOUT'):Promise<boolean> {
    const result=await this.pool.query(`UPDATE booking_offer SET status='EXPIRED',
      closure_reason=$2,resolved_at=now() WHERE trip_request_id=$1 AND status='PENDING'
      AND assignment_id IS NULL AND expires_at<=now() RETURNING trip_request_id`,[offerId,reason]);
    return Boolean(result.rowCount);
  }
  async noDriver(bookingId:string,reason:'NO_ELIGIBLE_DRIVER'|'OFFER_LIMIT_REACHED'|'SEARCH_TIMEOUT'):
    Promise<boolean> {
    return this.transaction(async db=>{
      const found=await db.query<Booking>('SELECT * FROM booking WHERE booking_id=$1 FOR UPDATE',
        [bookingId]);const booking=found.rows[0];
      if(!booking||booking.status!=='FINDING_DRIVER') return false;
      const creating=await db.query<Operation>(`SELECT * FROM booking_operation
        WHERE operation_id=$1 FOR UPDATE`,[booking.create_operation_id]);
      if(creating.rows[0]?.guard_disposition!=='KEEP_BOOKING_GUARD') return false;
      const cancelling=await db.query(`SELECT 1 FROM booking_operation
        WHERE booking_id=$1 AND operation_type='CANCEL_BOOKING'`,[bookingId]);
      if(cancelling.rowCount) return false;
      const pending=await db.query('SELECT 1 FROM booking_offer WHERE booking_id=$1 AND status=$2',
        [bookingId,'PENDING']);
      const assignment=await db.query(`SELECT 1 FROM booking_assignment
        WHERE booking_id=$1 AND state<>'COMPENSATED'`,
        [bookingId]);
      if(pending.rowCount||assignment.rowCount) return false;
      // Decision turns RELEASE before remote tombstone. Public terminal state waits
      // for Customer's release confirmation in the coordinator.
      await db.query(`UPDATE booking_operation SET guard_disposition='RELEASE_BOOKING_GUARD',
        updated_at=now() WHERE operation_id=$1`,[booking.create_operation_id]);
      await db.query(`UPDATE booking_dispatch SET failure_reason=$2,updated_at=now()
        WHERE booking_id=$1`,[bookingId,reason]);
      return true;
    });
  }
  async finishNoDriver(bookingId:string):Promise<void> {
    await this.transaction(async db=>{
      const found=await db.query<Booking>('SELECT * FROM booking WHERE booking_id=$1 FOR UPDATE',
        [bookingId]);const booking=found.rows[0];if(!booking||booking.status!=='FINDING_DRIVER') return;
      const cancelling=await db.query(`SELECT 1 FROM booking_operation
        WHERE booking_id=$1 AND operation_type='CANCEL_BOOKING'`,[bookingId]);
      if(cancelling.rowCount) return;
      const changed=await db.query<Booking>(`UPDATE booking SET status='NO_DRIVER_FOUND',
        version=version+1,updated_at=now() WHERE booking_id=$1 RETURNING *`,[bookingId]);
      await db.query(`UPDATE booking_dispatch SET status='NO_DRIVER_AVAILABLE',ended_at=now(),
        updated_at=now() WHERE booking_id=$1 AND status='SEARCHING'`,[bookingId]);
      await db.query(`INSERT INTO booking_outbox
        (event_id,booking_id,aggregate_version,event_type,recipient_account_id,safe_payload)
        VALUES($1,$2,$3,'NO_DRIVER_FOUND',$4,'{}'::jsonb)`,[
        randomUUID(),bookingId,changed.rows[0]!.version,booking.customer_account_id]);
    });
  }

  async offersForDriver(driverId:string,limit:number,cursor?:string):Promise<Data> {
    if(!Number.isInteger(limit)||limit<1||limit>100||cursor!==undefined&&
        (!uuid.test(cursor))) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const found=await this.pool.query<Offer>(`SELECT * FROM booking_offer
      WHERE driver_id=$1 AND status='PENDING' AND expires_at>now()
        AND ($2::uuid IS NULL OR trip_request_id<$2::uuid)
      ORDER BY trip_request_id DESC LIMIT $3`,[driverId,cursor??null,limit+1]);
    const rows=found.rows.slice(0,limit);
    const items=[];for(const row of rows) {const booking=await this.booking(row.booking_id);
      if(!booking) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
      items.push(this.offerDto(row,booking));}
    return {items,...(found.rows.length>limit&&rows.at(-1)?
      {next_cursor:rows.at(-1)!.trip_request_id}:{})};
  }
  async rejectOffer(offerId:string,driverId:string,reason?:string):Promise<Offer> {
    return this.transaction(async db=>{
      const found=await db.query<Offer>(`SELECT * FROM booking_offer
        WHERE trip_request_id=$1 FOR UPDATE`,[offerId]);const offer=found.rows[0];
      if(!offer||offer.driver_id!==driverId) throw fail(grpc.status.NOT_FOUND,'TRIP_REQUEST_NOT_FOUND');
      if(offer.status==='REJECTED') return offer;
      if(offer.status!=='PENDING'||offer.assignment_id)
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_REQUEST_NOT_PENDING');
      const changed=await db.query<Offer>(`UPDATE booking_offer SET status='REJECTED',
        reject_reason=$2,resolved_at=now() WHERE trip_request_id=$1 RETURNING *`,
        [offerId,reason??null]);
      return changed.rows[0]!;
    });
  }
  async claimOffer(offerId:string,driverId:string,accountId:string):Promise<Assignment> {
    return this.transaction(async db=>{
      const offerResult=await db.query<Offer>(`SELECT * FROM booking_offer
        WHERE trip_request_id=$1 FOR UPDATE`,[offerId]);const offer=offerResult.rows[0];
      if(!offer||offer.driver_id!==driverId||offer.driver_account_id!==accountId)
        throw fail(grpc.status.NOT_FOUND,'TRIP_REQUEST_NOT_FOUND');
      if(offer.assignment_id) {
        const old=await db.query<Assignment>('SELECT * FROM booking_assignment WHERE assignment_id=$1',
          [offer.assignment_id]);if(old.rows[0]) return old.rows[0];
      }
      if(offer.status!=='PENDING'||offer.expires_at<=new Date())
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_REQUEST_NOT_PENDING');
      const booked=await db.query<Booking>(`SELECT * FROM booking WHERE booking_id=$1 FOR UPDATE`,
        [offer.booking_id]);const booking=booked.rows[0];
      const dispatch=await db.query<Dispatch>(`SELECT * FROM booking_dispatch
        WHERE booking_id=$1 FOR UPDATE`,[offer.booking_id]);const process=dispatch.rows[0];
      if(!booking||booking.status!=='FINDING_DRIVER'||!process||
          process.status!=='SEARCHING'||process.deadline_at<=new Date())
        throw fail(grpc.status.FAILED_PRECONDITION,'DISPATCH_NOT_ACTIVE');
      const existing=await db.query<Assignment>(`SELECT * FROM booking_assignment
        WHERE booking_id=$1 AND state<>'COMPENSATED'`,[booking.booking_id]);
      if(existing.rows[0]) throw fail(grpc.status.ALREADY_EXISTS,'BOOKING_ALREADY_ASSIGNED');
      const assignmentId=randomUUID(),tripId=randomUUID(),now=new Date();
      const parties={customer_id:booking.customer_id,
        customer_account_id:booking.customer_account_id,driver_id:driverId,
        driver_account_id:accountId,vehicle_id:offer.vehicle_id};
      const assigned=await db.query<Assignment>(`INSERT INTO booking_assignment
        (assignment_id,booking_id,trip_request_id,trip_id,state,customer_id,driver_id,
          vehicle_id,parties,guard_ref,pickup,destination,pricing,claimed_at,
          offer_expires_at,dispatch_deadline_at)
        VALUES($1,$2,$3,$4,'CLAIMED',$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,
          $11::jsonb,$12::jsonb,$13,$14,$15) RETURNING *`,[
        assignmentId,booking.booking_id,offerId,tripId,booking.customer_id,driverId,
        offer.vehicle_id,JSON.stringify(parties),JSON.stringify(booking.guard_ref),
        JSON.stringify(booking.pickup),JSON.stringify(booking.destination),
        JSON.stringify(booking.pricing_snapshot),now,offer.expires_at,process.deadline_at]);
      await db.query(`UPDATE booking_offer SET assignment_id=$2,trip_id=$3
        WHERE trip_request_id=$1 AND status='PENDING'`,[offerId,assignmentId,tripId]);
      return assigned.rows[0]!;
    });
  }
  async assignment(assignmentId:string):Promise<Assignment|undefined> {
    const result=await this.pool.query<Assignment>(`SELECT * FROM booking_assignment
      WHERE assignment_id=$1`,[assignmentId]);return result.rows[0];
  }
  async assignmentByBooking(bookingId:string):Promise<Assignment|undefined> {
    const result=await this.pool.query<Assignment>(`SELECT * FROM booking_assignment
      WHERE booking_id=$1 AND state<>'COMPENSATED'`,[bookingId]);return result.rows[0];
  }
  async pendingAssignments(limit=10):Promise<string[]> {
    const result=await this.pool.query<{assignment_id:string}>(`SELECT assignment_id
      FROM booking_assignment WHERE state IN ('CLAIMED','PREPARING','ACTIVATING','COMPENSATING')
      ORDER BY claimed_at LIMIT $1`,[limit]);return result.rows.map(row=>row.assignment_id);
  }
  assignmentDto(row:Assignment):Data {return {assignment_id:row.assignment_id,
    booking_id:row.booking_id,trip_request_id:row.trip_request_id,trip_id:row.trip_id,
    customer_id:row.customer_id,driver_id:row.driver_id,vehicle_id:row.vehicle_id,
    state:row.state,claimed_at:stamp(row.claimed_at),offer_expires_at:stamp(row.offer_expires_at),
    dispatch_deadline_at:stamp(row.dispatch_deadline_at),cancel_requested:row.cancel_requested,
    version:String(row.version),parties:row.parties,pickup:row.pickup,
    destination:row.destination,pricing:row.pricing,guard:row.guard_ref};}
  async saveReservation(assignmentId:string,reservation:Data):Promise<void> {
    const result=await this.pool.query(`UPDATE booking_assignment SET reservation_ref=$2::jsonb,
      updated_at=now() WHERE assignment_id=$1 AND state='CLAIMED'
      AND reservation_ref IS NULL`,[assignmentId,JSON.stringify(reservation)]);
    if(result.rowCount!==1) {const row=await this.assignment(assignmentId);
      // PostgreSQL jsonb does not preserve object key order. A concurrent replay
      // may read the same reservation back with a different serialization order.
      if(!row||!isDeepStrictEqual(row.reservation_ref,reservation))
        throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_CHANGED');}
  }
  async advanceAssignment(assignmentId:string,from:string,to:string):Promise<void> {
    const result=await this.pool.query(`UPDATE booking_assignment SET state=$3,
      version=version+1,updated_at=now() WHERE assignment_id=$1 AND state=$2
      AND cancel_requested=false`,[assignmentId,from,to]);
    if(result.rowCount!==1) {const row=await this.assignment(assignmentId);
      if(!row||row.state!==to) throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_CHANGED');}
  }
  async completeAssignment(assignmentId:string):Promise<Booking> {
    return this.transaction(async db=>{
      const found=await db.query<Assignment>(`SELECT * FROM booking_assignment
        WHERE assignment_id=$1 FOR UPDATE`,[assignmentId]);const assignment=found.rows[0];
      if(!assignment) throw fail(grpc.status.NOT_FOUND,'ASSIGNMENT_NOT_FOUND');
      const booked=await db.query<Booking>(`SELECT * FROM booking WHERE booking_id=$1 FOR UPDATE`,
        [assignment.booking_id]);const booking=booked.rows[0];
      if(!booking) throw fail(grpc.status.NOT_FOUND,'BOOKING_NOT_FOUND');
      if(assignment.state==='ASSIGNED') return booking;
      if(assignment.state!=='ACTIVATING'||assignment.cancel_requested||
          booking.status!=='FINDING_DRIVER')
        throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_CHANGED');
      const updated=await db.query<Booking>(`UPDATE booking SET status='DRIVER_ASSIGNED',
        driver_id=$2,driver_account_id=$3,trip_id=$4,version=version+1,updated_at=now()
        WHERE booking_id=$1 RETURNING *`,[assignment.booking_id,assignment.driver_id,
        (assignment.parties as Data).driver_account_id,assignment.trip_id]);
      await db.query(`UPDATE booking_assignment SET state='ASSIGNED',version=version+1,
        updated_at=now() WHERE assignment_id=$1`,[assignmentId]);
      await db.query(`UPDATE booking_offer SET status='ACCEPTED',resolved_at=now()
        WHERE trip_request_id=$1 AND status='PENDING'`,[assignment.trip_request_id]);
      await db.query(`UPDATE booking_dispatch SET status='DRIVER_FOUND',ended_at=now(),
        updated_at=now() WHERE booking_id=$1`,[assignment.booking_id]);
      await db.query(`INSERT INTO booking_outbox(event_id,booking_id,aggregate_version,
        event_type,recipient_account_id,safe_payload) VALUES($1,$2,$3,
        'DRIVER_ASSIGNED',$4,'{}'::jsonb)`,[randomUUID(),booking.booking_id,
        updated.rows[0]!.version,booking.customer_account_id]);
      return updated.rows[0]!;
    });
  }
  async markCompensating(assignmentId:string,reason:string):Promise<void> {
    await this.pool.query(`UPDATE booking_assignment SET state='COMPENSATING',
      failure_reason=$2,version=version+1,updated_at=now()
      WHERE assignment_id=$1 AND state IN ('CLAIMED','PREPARING','ACTIVATING')`,
      [assignmentId,reason]);
  }
  async completeCompensation(assignmentId:string):Promise<void> {
    await this.transaction(async db=>{
      const rows=await db.query<Assignment>(`SELECT * FROM booking_assignment
        WHERE assignment_id=$1 FOR UPDATE`,[assignmentId]);const assignment=rows.rows[0];
      if(!assignment||assignment.state==='COMPENSATED') return;
      if(assignment.state!=='COMPENSATING')
        throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_CHANGED');
      await db.query(`UPDATE booking_assignment SET state='COMPENSATED',version=version+1,
        updated_at=now() WHERE assignment_id=$1`,[assignmentId]);
      await db.query(`UPDATE booking_offer SET status='CANCELLED',closure_reason='DRIVER_UNAVAILABLE',
        trip_id=NULL,resolved_at=now() WHERE trip_request_id=$1 AND status='PENDING'`,
        [assignment.trip_request_id]);
    });
  }
  async paymentContext(tripId:string):Promise<Data> {
    const found=await this.pool.query<Booking>(`SELECT * FROM booking
      WHERE trip_id=$1 AND status='DRIVER_ASSIGNED'`,[tripId]);const row=found.rows[0];
    if(!row||!row.driver_id) throw fail(grpc.status.NOT_FOUND,'BOOKING_NOT_FOUND');
    return {booking_id:row.booking_id,trip_id:tripId,customer_id:row.customer_id,
      driver_id:row.driver_id,pricing:row.pricing_snapshot,
      pricing_operation_id:row.pricing_operation_id};
  }
  async requestCancel(bookingId:string,reason:string,accountId:string):Promise<Operation> {
    return this.transaction(async db=>{
      const found=await db.query<Booking>(`SELECT * FROM booking WHERE booking_id=$1 FOR UPDATE`,
        [bookingId]);const booking=found.rows[0];
      if(!booking) throw fail(grpc.status.NOT_FOUND,'BOOKING_NOT_FOUND');
      const prior=await db.query<Operation>(`SELECT * FROM booking_operation WHERE booking_id=$1
        AND operation_type='CANCEL_BOOKING'`,[bookingId]);
      if(prior.rows[0]) return prior.rows[0];
      if(booking.status==='DRIVER_ASSIGNED')
        throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_ALREADY_ASSIGNED');
      if(booking.status==='NO_DRIVER_FOUND')
        throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_NOT_CANCELLABLE');
      if(!['PENDING','FINDING_DRIVER'].includes(booking.status))
        throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_NOT_CANCELLABLE');
      const source=await db.query<Operation>('SELECT * FROM booking_operation WHERE operation_id=$1',
        [booking.create_operation_id]);
      if(source.rows[0]?.guard_disposition!=='KEEP_BOOKING_GUARD')
        throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_NOT_CANCELLABLE');
      const operationId=randomUUID();
      const operation=await db.query<Operation>(`INSERT INTO booking_operation
        (operation_id,operation_type,booking_id,customer_id,customer_account_id,state,
          guard_disposition,request_snapshot)
        VALUES($1,'CANCEL_BOOKING',$2,$3,$4,'PROCESSING','RELEASE_BOOKING_GUARD',
          $5::jsonb) RETURNING *`,[operationId,bookingId,booking.customer_id,
        booking.customer_account_id,JSON.stringify({reason,cancelled_by:accountId})]);
      await db.query(`UPDATE booking_operation SET guard_disposition='RELEASE_BOOKING_GUARD',
        updated_at=now() WHERE operation_id=$1`,[booking.create_operation_id]);
      await db.query(`UPDATE booking_offer SET status='CANCELLED',resolved_at=now(),
        closure_reason='BOOKING_CANCELLED' WHERE booking_id=$1 AND status='PENDING'
        AND assignment_id IS NULL`,[bookingId]);
      await db.query(`UPDATE booking_assignment SET cancel_requested=true,version=version+1,
        updated_at=now() WHERE booking_id=$1 AND state NOT IN ('ASSIGNED','COMPENSATED')`,
        [bookingId]);
      return operation.rows[0]!;
    });
  }
  async processingCancels(limit=10):Promise<string[]> {
    const rows=await this.pool.query<{operation_id:string}>(`SELECT operation_id
      FROM booking_operation WHERE operation_type='CANCEL_BOOKING' AND state='PROCESSING'
      ORDER BY created_at LIMIT $1`,[limit]);return rows.rows.map(row=>row.operation_id);
  }
  async beginCancelCompensation(assignmentId:string):Promise<void> {
    await this.pool.query(`UPDATE booking_assignment SET state='COMPENSATING',
      version=version+1,updated_at=now() WHERE assignment_id=$1
      AND cancel_requested=true AND state IN ('CLAIMED','PREPARING','ACTIVATING')`,
      [assignmentId]);
  }
  async cancelLost(bookingId:string):Promise<void> {
    await this.transaction(async db=>{
      const assigned=await db.query<Assignment>(`SELECT * FROM booking_assignment
        WHERE booking_id=$1 AND state<>'COMPENSATED' FOR UPDATE`,[bookingId]);
      const assignment=assigned.rows[0];
      if(assignment&&assignment.state!=='ASSIGNED')
        await db.query(`UPDATE booking_assignment SET cancel_requested=false,
          state='ACTIVATING',version=version+1,updated_at=now()
          WHERE assignment_id=$1`,[assignment.assignment_id]);
      await db.query(`UPDATE booking_operation SET guard_disposition='KEEP_BOOKING_GUARD'
        WHERE operation_id=(SELECT create_operation_id FROM booking WHERE booking_id=$1)`,
        [bookingId]);
      await db.query(`UPDATE booking_operation SET state='FAILED',
        error_code='BOOKING_ALREADY_ASSIGNED',failure_http_status=409,updated_at=now()
        WHERE booking_id=$1 AND operation_type='CANCEL_BOOKING' AND state='PROCESSING'`,
        [bookingId]);
    });
  }
  async finishCancelled(operationId:string):Promise<Data> {
    return this.transaction(async db=>{
      const selected=await db.query<Operation>(`SELECT * FROM booking_operation
        WHERE operation_id=$1 AND operation_type='CANCEL_BOOKING' FOR UPDATE`,[operationId]);
      const operation=selected.rows[0];
      if(!operation) throw fail(grpc.status.NOT_FOUND,'OPERATION_NOT_FOUND');
      if(operation.state==='SUCCEEDED') return operation.response_snapshot!;
      if(operation.state!=='PROCESSING') throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_NOT_CANCELLABLE');
      const active=await db.query(`SELECT 1 FROM booking_assignment
        WHERE booking_id=$1 AND state<>'COMPENSATED'`,[operation.booking_id]);
      if(active.rowCount) throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_IN_PROGRESS');
      const result=await db.query<Booking>(`UPDATE booking SET status='CANCELLED',
        cancellation=$2::jsonb,version=version+1,updated_at=now()
        WHERE booking_id=$1 AND status IN ('PENDING','FINDING_DRIVER') RETURNING *`,[
        operation.booking_id,JSON.stringify({reason:operation.request_snapshot.reason,
          cancelled_by:operation.request_snapshot.cancelled_by,cancelled_at:stamp(new Date())})]);
      const booking=result.rows[0];
      if(!booking) throw fail(grpc.status.FAILED_PRECONDITION,'BOOKING_NOT_CANCELLABLE');
      await db.query(`UPDATE booking_dispatch SET status='CANCELLED',ended_at=now(),
        updated_at=now() WHERE booking_id=$1 AND status='SEARCHING'`,[booking.booking_id]);
      const snapshot=this.bookingDto(booking);
      await db.query(`UPDATE booking_operation SET state='SUCCEEDED',response_snapshot=$2::jsonb,
        updated_at=now() WHERE operation_id=$1`,[operationId,JSON.stringify(snapshot)]);
      await db.query(`INSERT INTO booking_outbox(event_id,booking_id,aggregate_version,
        event_type,recipient_account_id,safe_payload)
        VALUES($1,$2,$3,'BOOKING_CANCELLED',$4,$5::jsonb)`,[
        randomUUID(),booking.booking_id,booking.version,booking.customer_account_id,
        JSON.stringify({reasonText:operation.request_snapshot.reason})]);
      return snapshot;
    });
  }
}
