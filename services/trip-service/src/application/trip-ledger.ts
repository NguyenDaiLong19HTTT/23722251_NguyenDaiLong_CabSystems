import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {facadeError} from '@cab/grpc-transport';
import type pg from 'pg';

export type Data=Record<string,unknown>;
export const record=(value:unknown):value is Data=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const fail=(status:grpc.status,reason:string)=>facadeError(status,reason);
export function id(value:unknown):string {if(typeof value!=='string'||!uuid.test(value))
  throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');return value;}
export function version(value:unknown):string {if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value))
  throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');return value;}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest();
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),nanos:(date.getTime()%1000)*1e6});
const fromStamp=(value:unknown):Date=>{
  if(!record(value)||typeof value.seconds!=='string'||!/^\d+$/.test(value.seconds)||
      typeof value.nanos!=='number'||!Number.isInteger(value.nanos)||
      value.nanos<0||value.nanos>=1e9) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  const date=new Date(Number(value.seconds)*1000+Math.floor(value.nanos/1e6));
  if(!Number.isFinite(date.getTime())) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return date;
};
type Preparation={assignment_id:string;trip_id:string;booking_id:string;state:string;
  version:string;request_digest:Buffer|null;parties:Data|null;guard_ref:Data|null;
  reservation_ref:Data|null;pickup:Data|null;destination:Data|null;pricing:Data|null};
type Trip={trip_id:string;assignment_id:string;booking_id:string;customer_id:string;
  customer_account_id:string;driver_id:string;driver_account_id:string;vehicle_id:string;
  guard_ref:Data;reservation_ref:Data;pricing:Data;pickup:Data;destination:Data;
  status:string;version:string;start_check_id:string|null;start_check_version:string|null;
  status_before_error:string|null;
  arrived_at:Date|null;picked_up_at:Date|null;started_at:Date|null;completed_at:Date|null;
  closed_at:Date|null;cancellation:Data|null;created_at:Date;updated_at:Date};
type History={version:string;previous_status:string|null;new_status:string;actor_type:string;
  actor_id:string;changed_at:Date;reason:string|null};

export class TripLedger {
  constructor(private readonly pool:pg.Pool,private readonly cursorKey?:Buffer) {}
  async hasCustomerDriverTrip(customerId:string,customerAccountId:string,
    driverAccountId:string):Promise<boolean> {
    const result=await this.pool.query<{related:boolean}>(
      `SELECT EXISTS(SELECT 1 FROM trip WHERE customer_id=$1 AND customer_account_id=$2
        AND driver_account_id=$3) AS related`,[customerId,customerAccountId,driverAccountId]);
    return result.rows[0]?.related===true;
  }
  async recordAssignedLocation(input:Data):Promise<Data> {
    const sampleId=id(input.sample_id),assignmentId=id(input.assignment_id),
      tripId=id(input.trip_id),driverId=id(input.driver_id);
    const point=record(input.point)?input.point:{};
    if(typeof point.latitude!=='number'||!Number.isFinite(point.latitude)||
        Math.abs(point.latitude)>90||typeof point.longitude!=='number'||
        !Number.isFinite(point.longitude)||Math.abs(point.longitude)>180)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const recordedAt=fromStamp(input.recorded_at),receivedAt=fromStamp(input.received_at);
    if(recordedAt>receivedAt||receivedAt.getTime()>Date.now()+1000)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return this.transaction(async db=>{
      const trip=await db.query<Trip>('SELECT * FROM trip WHERE trip_id=$1 FOR SHARE',[tripId]);
      const row=trip.rows[0];
      if(!row||row.assignment_id!==assignmentId||row.driver_id!==driverId)
        throw fail(grpc.status.FAILED_PRECONDITION,'ASSIGNMENT_MISMATCH');
      const prior=await db.query<{trip_id:string;driver_id:string;latitude:number;
        longitude:number;recorded_at:Date;received_at:Date}>(
        'SELECT * FROM trip_route_point WHERE sample_id=$1',[sampleId]);
      if(prior.rows[0]) {
        const old=prior.rows[0];
        if(old.trip_id!==tripId||old.driver_id!==driverId||
            old.latitude!==point.latitude||old.longitude!==point.longitude||
            old.recorded_at.getTime()!==recordedAt.getTime()||
            old.received_at.getTime()!==receivedAt.getTime())
          throw fail(grpc.status.ALREADY_EXISTS,'LOCATION_SAMPLE_CONFLICT');
        return {sample_id:sampleId,trip_id:tripId,recorded:true};
      }
      if(row.closed_at||recordedAt<row.created_at)
        return {sample_id:sampleId,trip_id:tripId,recorded:false};
      await db.query(`INSERT INTO trip_route_point(sample_id,trip_id,driver_id,latitude,
        longitude,recorded_at,received_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[
        sampleId,tripId,driverId,point.latitude,point.longitude,recordedAt,receivedAt]);
      return {sample_id:sampleId,trip_id:tripId,recorded:true};
    });
  }
  private cursor(value:Data):string {
    if(!this.cursorKey) throw new Error('Trip cursor key unavailable');
    const body=Buffer.from(JSON.stringify(value)).toString('base64url');
    return body+'.'+createHmac('sha256',this.cursorKey).update(body).digest('base64url');
  }
  private cursorValue(value:string|undefined,scope:string,filters:Data):{createdAt:string;tripId:string}|undefined {
    if(!value) return;
    if(!this.cursorKey||value.length>1024||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(value))
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    const [body,mac]=value.split('.');const actual=createHmac('sha256',this.cursorKey)
      .update(body!).digest();const supplied=Buffer.from(mac!,'base64url');
    if(supplied.length!==actual.length||!timingSafeEqual(supplied,actual))
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    let decoded:Data;
    try {decoded=JSON.parse(Buffer.from(body!,'base64url').toString('utf8')) as Data;}
    catch {throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');}
    if(decoded.expiresAt&&Number(decoded.expiresAt)<=Date.now())
      throw fail(grpc.status.INVALID_ARGUMENT,'CURSOR_EXPIRED');
    if(decoded.scope!==scope||JSON.stringify(decoded.filters)!==JSON.stringify(filters)||
        typeof decoded.createdAt!=='string'||typeof decoded.tripId!=='string'||
        !uuid.test(decoded.tripId)||!Number.isFinite(Date.parse(decoded.createdAt)))
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    return {createdAt:decoded.createdAt,tripId:decoded.tripId};
  }
  async list(scope:{role:string;accountId:string;customerId?:string;driverId?:string},
    filters:{status?:string;from?:Date;to?:Date;limit:number;cursor?:string}):Promise<Data> {
    const identity=scope.role+':'+scope.accountId;
    const filterKey={status:filters.status??null,from:filters.from?.toISOString()??null,
      to:filters.to?.toISOString()??null,limit:filters.limit};
    const after=this.cursorValue(filters.cursor,identity,filterKey);
    const own=scope.role==='CUSTOMER'?'customer_id':scope.role==='DRIVER'?'driver_id':undefined;
    const ownAccount=scope.role==='CUSTOMER'?'customer_account_id':
      scope.role==='DRIVER'?'driver_account_id':undefined;
    if(!own) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const owner=scope.role==='CUSTOMER'?scope.customerId:scope.driverId;
    if(!owner) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const result=await this.pool.query<Trip>(`SELECT * FROM trip WHERE ${own}=$1
      AND ${ownAccount}=$8
      AND ($2::text IS NULL OR status=$2)
      AND ($3::timestamptz IS NULL OR created_at>=$3)
      AND ($4::timestamptz IS NULL OR created_at<$4)
      AND ($5::timestamptz IS NULL OR (created_at,trip_id)<($5,$6::uuid))
      ORDER BY created_at DESC,trip_id DESC LIMIT $7`,[
      owner,filters.status??null,filters.from??null,filters.to??null,
      after?.createdAt??null,after?.tripId??null,filters.limit+1,scope.accountId]);
    const rows=result.rows.slice(0,filters.limit);
    const items=rows.map(row=>({trip_id:row.trip_id,booking_id:row.booking_id,
      trip_status:row.status,vehicle_type:row.pricing.vehicle_type,
      pickup:row.pickup,destination:row.destination,created_at:stamp(row.created_at),
      ...(row.closed_at?{closed_at:stamp(row.closed_at)}:{})}));
    const last=rows.at(-1);
    return {items,...(result.rows.length>filters.limit&&last?{next_cursor:this.cursor({
      scope:identity,filters:filterKey,createdAt:last.created_at.toISOString(),tripId:last.trip_id,
      expiresAt:Date.now()+15*60*1000})}:{})};
  }
  async transaction<T>(fn:(db:pg.PoolClient)=>Promise<T>):Promise<T> {
    const db=await this.pool.connect();
    try {await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}
    catch(error) {await db.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally {db.release();}
  }
  private prepDto(row:Preparation):Data {return {assignment_id:row.assignment_id,
    trip_id:row.trip_id,booking_id:row.booking_id,state:row.state,version:row.version};}
  private prepareHash(input:Data):Buffer {return hash([input.assignment_id,input.trip_id,
    input.booking_id,input.parties,input.guard,input.reservation,input.pickup,
    input.destination,input.pricing]);}
  private async internalReplay(commandId:string,operation:string,tripId:string,
    digest:Buffer):Promise<Data|undefined> {
    const found=await this.pool.query<{trip_id:string;operation:string;request_digest:Buffer;
      response_snapshot:Data}>('SELECT * FROM trip_receipt WHERE command_id=$1',[commandId]);
    const row=found.rows[0];if(!row) return;
    if(row.trip_id!==tripId||row.operation!==operation||!row.request_digest.equals(digest))
      throw fail(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
    return row.response_snapshot;
  }
  async prepareReplay(input:Data):Promise<Data|undefined> {
    const command=record(input.command)?input.command:{};
    return this.internalReplay(id(command.command_id),'PREPARE',id(input.trip_id),
      this.prepareHash(input));
  }
  async activateReplay(assignmentId:string,commandId:string,expected:string,tripId:string) {
    return this.internalReplay(commandId,'ACTIVATE',tripId,hash([assignmentId,expected]));
  }
  async cancelPreparationReplay(input:Data):Promise<Data|undefined> {
    const command=record(input.command)?input.command:{};
    return this.internalReplay(id(command.command_id),'CANCEL_PREPARATION',id(input.trip_id),
      hash([input.assignment_id,input.trip_id,input.booking_id]));
  }
  async preparation(assignmentId:string):Promise<Data> {
    const found=await this.pool.query<Preparation>('SELECT * FROM trip_preparation WHERE assignment_id=$1',
      [assignmentId]);
    if(!found.rows[0]) throw fail(grpc.status.NOT_FOUND,'TRIP_PREPARATION_NOT_FOUND');
    return this.prepDto(found.rows[0]);
  }
  async preparationSnapshot(assignmentId:string):Promise<Data> {
    const found=await this.pool.query<Preparation>('SELECT * FROM trip_preparation WHERE assignment_id=$1',
      [assignmentId]);
    const row=found.rows[0];if(!row) throw fail(grpc.status.NOT_FOUND,'TRIP_PREPARATION_NOT_FOUND');
    return {assignment_id:row.assignment_id,trip_id:row.trip_id,booking_id:row.booking_id,
      parties:row.parties,guard:row.guard_ref,reservation:row.reservation_ref,
      pickup:row.pickup,destination:row.destination,pricing:row.pricing};
  }
  async prepare(input:Data):Promise<Data> {
    const replay=await this.prepareReplay(input);if(replay) return replay;
    const assignmentId=id(input.assignment_id),tripId=id(input.trip_id),bookingId=id(input.booking_id);
    const parts=input.parties,guard=input.guard,reservation=input.reservation;
    if(!record(input.command)||!uuid.test(String(input.command.command_id))||
        !record(parts)||!record(guard)||!record(reservation)||!record(input.pickup)||
        !record(input.destination)||!record(input.pricing)||
        input.pricing.vehicle_type!=='MOTORBIKE'||
        ![parts.customer_id,parts.customer_account_id,parts.driver_id,parts.driver_account_id,
          parts.vehicle_id].every(value=>typeof value==='string'&&uuid.test(value))||
        guard.booking_id!==bookingId||reservation.assignment_id!==assignmentId||
        reservation.booking_id!==bookingId||reservation.driver_id!==parts.driver_id||
        reservation.vehicle_id!==parts.vehicle_id)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const digest=this.prepareHash(input),commandId=id((input.command as Data).command_id);
    return this.transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[assignmentId]);
      const replay=await this.receipt(db,commandId,digest);if(replay) return replay;
      const existing=await db.query<Preparation>(
        'SELECT * FROM trip_preparation WHERE assignment_id=$1 FOR UPDATE',[assignmentId]);
      if(existing.rows[0]) {
        const row=existing.rows[0];
        if(row.trip_id!==tripId||row.booking_id!==bookingId||
            row.request_digest&&!row.request_digest.equals(digest))
          throw fail(grpc.status.ALREADY_EXISTS,'TRIP_PREPARATION_CONFLICT');
        if(row.state==='PREPARATION_CANCELLED')
          throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_PREPARATION_CANCELLED');
        const response=this.prepDto(row);
        await this.save(db,commandId,tripId,'PREPARE',digest,response);
        return response;
      }
      const added=await db.query<Preparation>(`INSERT INTO trip_preparation
        (assignment_id,trip_id,booking_id,state,version,request_digest,parties,guard_ref,
         reservation_ref,pickup,destination,pricing)
        VALUES($1,$2,$3,'PREPARED',1,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[
        assignmentId,tripId,bookingId,digest,JSON.stringify(parts),JSON.stringify(guard),
        JSON.stringify(reservation),JSON.stringify(input.pickup),JSON.stringify(input.destination),
        JSON.stringify(input.pricing)]);
      const response=this.prepDto(added.rows[0]!);
      await this.save(db,commandId,tripId,'PREPARE',digest,response);
      return response;
    });
  }
  async cancelPreparation(input:Data):Promise<Data> {
    const replay=await this.cancelPreparationReplay(input);if(replay) return replay;
    const assignmentId=id(input.assignment_id),tripId=id(input.trip_id),bookingId=id(input.booking_id);
    const commandId=id(record(input.command)?input.command.command_id:undefined);
    const digest=hash([assignmentId,tripId,bookingId]);
    return this.transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[assignmentId]);
      const replay=await this.receipt(db,commandId,digest);if(replay) return replay;
      const found=await db.query<Preparation>(
        'SELECT * FROM trip_preparation WHERE assignment_id=$1 FOR UPDATE',[assignmentId]);
      if(found.rows[0]) {
        const row=found.rows[0];
        if(row.trip_id!==tripId||row.booking_id!==bookingId)
          throw fail(grpc.status.ALREADY_EXISTS,'TRIP_PREPARATION_CONFLICT');
        if(row.state==='ACTIVE') throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_ALREADY_ACTIVE');
        if(row.state==='PREPARATION_CANCELLED') {const response=this.prepDto(row);
          await this.save(db,commandId,tripId,'CANCEL_PREPARATION',digest,response);return response;}
        const changed=await db.query<Preparation>(`UPDATE trip_preparation SET state='PREPARATION_CANCELLED',
          version=version+1,updated_at=now() WHERE assignment_id=$1 RETURNING *`,[assignmentId]);
        const response=this.prepDto(changed.rows[0]!);
        await this.save(db,commandId,tripId,'CANCEL_PREPARATION',digest,response);
        return response;
      }
      const added=await db.query<Preparation>(`INSERT INTO trip_preparation
        (assignment_id,trip_id,booking_id,state,version)
        VALUES($1,$2,$3,'PREPARATION_CANCELLED',1) RETURNING *`,[
        assignmentId,tripId,bookingId]);
      const response=this.prepDto(added.rows[0]!);
      await this.save(db,commandId,tripId,'CANCEL_PREPARATION',digest,response);
      return response;
    });
  }
  async activate(assignmentId:string,expected:string,commandId?:string):Promise<Data> {
    return this.transaction(async db=>{
      const found=await db.query<Preparation>(
        'SELECT * FROM trip_preparation WHERE assignment_id=$1 FOR UPDATE',[assignmentId]);
      const row=found.rows[0];
      if(!row) throw fail(grpc.status.NOT_FOUND,'TRIP_PREPARATION_NOT_FOUND');
      if(commandId) {const replay=await this.receipt(db,commandId,hash([assignmentId,expected]));
        if(replay) return replay;}
      if(row.state==='ACTIVE') {const response=this.prepDto(row);
        if(commandId) await this.save(db,commandId,row.trip_id,'ACTIVATE',
          hash([assignmentId,expected]),response);
        return response;}
      if(row.state!=='PREPARED') throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_PREPARATION_CANCELLED');
      if(row.version!==expected) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_VERSION_CONFLICT');
      const p=row.parties!;
      await db.query(`INSERT INTO trip(trip_id,assignment_id,booking_id,customer_id,
        customer_account_id,driver_id,driver_account_id,vehicle_id,guard_ref,reservation_ref,
        pricing,pickup,destination,status,version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRIVER_ASSIGNED',1)`,[
        row.trip_id,row.assignment_id,row.booking_id,p.customer_id,p.customer_account_id,
        p.driver_id,p.driver_account_id,p.vehicle_id,JSON.stringify(row.guard_ref),
        JSON.stringify(row.reservation_ref),JSON.stringify(row.pricing),
        JSON.stringify(row.pickup),JSON.stringify(row.destination)]);
      await db.query(`INSERT INTO trip_status_history
        (trip_id,version,new_status,actor_type,actor_id) VALUES($1,1,'DRIVER_ASSIGNED','SYSTEM','booking-service')`,
        [row.trip_id]);
      const changed=await db.query<Preparation>(`UPDATE trip_preparation SET state='ACTIVE',
        version=version+1,updated_at=now() WHERE assignment_id=$1 RETURNING *`,[assignmentId]);
      const response=this.prepDto(changed.rows[0]!);
      if(commandId) await this.save(db,commandId,row.trip_id,'ACTIVATE',
        hash([assignmentId,expected]),response);
      return response;
    });
  }
  async find(tripId:string):Promise<Trip|undefined> {return (await this.pool.query<Trip>(
    'SELECT * FROM trip WHERE trip_id=$1',[tripId])).rows[0];}
  async trackingPoint(tripId:string):Promise<{latitude:number;longitude:number;
    recorded_at:Date;received_at:Date}|undefined> {
    return (await this.pool.query<{latitude:number;longitude:number;recorded_at:Date;
      received_at:Date}>(`SELECT latitude,longitude,recorded_at,received_at
      FROM trip_route_point WHERE trip_id=$1 ORDER BY recorded_at DESC,sample_id DESC LIMIT 1`,
      [tripId])).rows[0];
  }
  private async dto(db:pg.Pool|pg.PoolClient,row:Trip):Promise<Data> {
    const history=(await db.query<History>(`SELECT * FROM trip_status_history
      WHERE trip_id=$1 ORDER BY version`,[row.trip_id])).rows.map(h=>({version:h.version,
      ...(h.previous_status?{previous_status:h.previous_status}:{}),new_status:h.new_status,
      actor_type:h.actor_type,actor_id:h.actor_id,changed_at:stamp(h.changed_at),
      ...(h.reason?{reason:h.reason}:{})}));
    return {trip_id:row.trip_id,booking_id:row.booking_id,customer_id:row.customer_id,
      driver_id:row.driver_id,vehicle_id:row.vehicle_id,
      vehicle_type:row.pricing.vehicle_type,pickup:row.pickup,destination:row.destination,
      trip_status:row.status,version:row.version,
      ...(row.arrived_at?{arrived_at:stamp(row.arrived_at)}:{}),
      ...(row.picked_up_at?{picked_up_at:stamp(row.picked_up_at)}:{}),
      ...(row.started_at?{started_at:stamp(row.started_at)}:{}),
      ...(row.completed_at?{completed_at:stamp(row.completed_at)}:{}),
      ...(row.closed_at?{closed_at:stamp(row.closed_at)}:{}),
      ...(row.cancellation?{cancellation:row.cancellation}:{}),
      ...(row.status_before_error?{status_before_error:row.status_before_error}:{}),
      created_at:stamp(row.created_at),updated_at:stamp(row.updated_at),status_history:history};
  }
  async view(tripId:string):Promise<Data> {const row=await this.find(tripId);
    if(!row) throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');return this.dto(this.pool,row);}
  async receipt(db:pg.PoolClient,commandId:string,digest:Buffer):Promise<Data|undefined> {
    const existing=await db.query<{request_digest:Buffer;response_snapshot:Data}>(
      'SELECT request_digest,response_snapshot FROM trip_receipt WHERE command_id=$1',[commandId]);
    if(!existing.rows[0]) return;
    if(!existing.rows[0].request_digest.equals(digest))
      throw fail(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
    return existing.rows[0].response_snapshot;
  }
  async statusReplay(commandId:string,tripId:string,expected:string,next:string,accountId:string):Promise<Data|undefined> {
    const digest=hash([tripId,expected,next,accountId]);
    const found=await this.pool.query<{trip_id:string;operation:string;request_digest:Buffer;
      response_snapshot:Data}>('SELECT * FROM trip_receipt WHERE command_id=$1',[commandId]);
    const row=found.rows[0];if(!row) return;
    if(row.trip_id!==tripId||row.operation!=='STATUS'||!row.request_digest.equals(digest))
      throw fail(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
    return row.response_snapshot;
  }
  private async save(db:pg.PoolClient,commandId:string,tripId:string,operation:string,
    digest:Buffer,response:Data) {
    await db.query(`INSERT INTO trip_receipt(command_id,trip_id,operation,request_digest,response_snapshot)
      VALUES($1,$2,$3,$4,$5::jsonb)`,[
      commandId,tripId,operation,digest,JSON.stringify(response)]);
  }
  async transition(input:{tripId:string;commandId:string;expected:string;next:string;
    accountId:string}):Promise<Data> {
    const digest=hash([input.tripId,input.expected,input.next,input.accountId]);
    return this.transaction(async db=>{
      const row=(await db.query<Trip>('SELECT * FROM trip WHERE trip_id=$1 FOR UPDATE',
        [input.tripId])).rows[0];
      if(!row||row.driver_account_id!==input.accountId)
        throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
      const replay=await this.receipt(db,input.commandId,digest);if(replay) return replay;
      if(row.version!==input.expected) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_VERSION_CONFLICT');
      const path:Record<string,string>={DRIVER_ASSIGNED:'ARRIVED_PICKUP',
        ARRIVED_PICKUP:'PICKED_UP',PICKED_UP:'IN_PROGRESS',IN_PROGRESS:'COMPLETED'};
      if(path[row.status]!==input.next) throw fail(grpc.status.FAILED_PRECONDITION,'INVALID_TRIP_TRANSITION');
      const column:Record<string,string>={ARRIVED_PICKUP:'arrived_at',PICKED_UP:'picked_up_at',
        IN_PROGRESS:'started_at',COMPLETED:'completed_at'};
      const field=column[input.next]!;
      const changed=(await db.query<Trip>(`UPDATE trip SET status=$2,version=version+1,
        ${field}=now(),closed_at=CASE WHEN $2='COMPLETED' THEN now() ELSE closed_at END,
        start_check_id=NULL,start_check_version=NULL,start_check_at=NULL,updated_at=now()
        WHERE trip_id=$1 RETURNING *`,[input.tripId,input.next])).rows[0]!;
      await db.query(`INSERT INTO trip_status_history
        (trip_id,version,previous_status,new_status,actor_type,actor_id)
        VALUES($1,$2,$3,$4,'USER',$5)`,[
        input.tripId,changed.version,row.status,input.next,input.accountId]);
      if(input.next==='COMPLETED') {
        await db.query(`INSERT INTO trip_closure(operation_id,trip_id)
          VALUES($1,$2)`,[randomUUID(),input.tripId]);
        await db.query(`INSERT INTO journey_metrics(trip_id,status) VALUES($1,'PENDING')`,
          [input.tripId]);
      }
      const eventType:Record<string,string>={ARRIVED_PICKUP:'DRIVER_ARRIVED',
        IN_PROGRESS:'TRIP_STARTED',COMPLETED:'TRIP_COMPLETED'};
      if(eventType[input.next]) await db.query(`INSERT INTO trip_outbox
        (event_id,trip_id,aggregate_version,event_type,safe_payload)
        VALUES($1,$2,$3,$4,'{}'::jsonb)`,[
        randomUUID(),input.tripId,changed.version,eventType[input.next]]);
      const response=await this.dto(db,changed);
      await this.save(db,input.commandId,input.tripId,'STATUS',digest,response);
      return response;
    });
  }
  async cancel(input:{tripId:string;commandId:string;expected:string;reasonCode:string;
    reason:string;accountId:string;role:string}):Promise<Data> {
    const digest=hash([input.tripId,input.expected,input.reasonCode,input.reason,input.accountId]);
    return this.transaction(async db=>{
      const row=(await db.query<Trip>('SELECT * FROM trip WHERE trip_id=$1 FOR UPDATE',
        [input.tripId])).rows[0];
      if(!row||input.role==='CUSTOMER'&&row.customer_account_id!==input.accountId||
          input.role==='DRIVER'&&row.driver_account_id!==input.accountId)
        throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
      const replay=await this.receipt(db,input.commandId,digest);if(replay) return replay;
      if(row.version!==input.expected) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_VERSION_CONFLICT');
      if(row.status==='CANCELLED') {const response=await this.dto(db,row);
        await this.save(db,input.commandId,input.tripId,'CANCEL',digest,response);return response;}
      if(!['DRIVER_ASSIGNED','ARRIVED_PICKUP'].includes(row.status))
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_CANCELLABLE');
      if(input.reasonCode==='NO_SHOW'&&(row.status!=='ARRIVED_PICKUP'||!row.arrived_at||
          Date.now()-row.arrived_at.getTime()<300000))
        throw fail(grpc.status.FAILED_PRECONDITION,'NO_SHOW_WAIT_NOT_REACHED');
      const cancelledAt=(await db.query<{at:Date}>('SELECT now() AS at')).rows[0]!.at;
      const cancellation={reason_code:input.reasonCode,reason:input.reason,
        cancelled_by:input.accountId,cancelled_at:stamp(cancelledAt)};
      const changed=(await db.query<Trip>(`UPDATE trip SET status='CANCELLED',version=version+1,
        closed_at=$2,cancellation=$3::jsonb,start_check_id=NULL,start_check_version=NULL,
        start_check_at=NULL,updated_at=$2 WHERE trip_id=$1 RETURNING *`,[
        input.tripId,cancelledAt,JSON.stringify(cancellation)])).rows[0]!;
      await db.query(`INSERT INTO trip_status_history
        (trip_id,version,previous_status,new_status,actor_type,actor_id,reason)
        VALUES($1,$2,$3,'CANCELLED','USER',$4,$5)`,[
        input.tripId,changed.version,row.status,input.accountId,input.reason]);
      await db.query(`INSERT INTO trip_closure(operation_id,trip_id,payment_fence)
        VALUES($1,$2,'PENDING')`,[randomUUID(),input.tripId]);
      await db.query(`INSERT INTO trip_outbox
        (event_id,trip_id,aggregate_version,event_type,safe_payload)
        VALUES($1,$2,$3,'TRIP_CANCELLED',$4::jsonb)`,[
        randomUUID(),input.tripId,changed.version,JSON.stringify({reasonCode:input.reasonCode,
          reasonText:Array.from(input.reason).slice(0,1000).join('')})]);
      const response=await this.dto(db,changed);
      await this.save(db,input.commandId,input.tripId,'CANCEL',digest,response);
      return response;
    });
  }
  async incident(input:{tripId:string;commandId:string;expected:string;issueType:string;
    description:string;accountId:string}):Promise<Data> {
    const digest=hash([input.tripId,input.expected,input.issueType,input.description,
      input.accountId]);
    return this.transaction(async db=>{
      const row=(await db.query<Trip>('SELECT * FROM trip WHERE trip_id=$1 FOR UPDATE',
        [input.tripId])).rows[0];
      if(!row||row.driver_account_id!==input.accountId)
        throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
      const replay=await this.receipt(db,input.commandId,digest);
      if(replay) return replay;
      if(row.version!==input.expected)
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_VERSION_CONFLICT');
      if(row.closed_at||!['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS',
        'ERROR'].includes(row.status))
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_CLOSED');
      const entering=row.status!=='ERROR';
      const changed=(await db.query<Trip>(`UPDATE trip SET status='ERROR',
        status_before_error=CASE WHEN status='ERROR' THEN status_before_error ELSE status END,
        version=version+1,updated_at=now() WHERE trip_id=$1 RETURNING *`,
        [input.tripId])).rows[0]!;
      const incidentId=randomUUID();
      const inserted=(await db.query<{created_at:Date}>(`INSERT INTO trip_incident
        (incident_id,trip_id,command_id,issue_type,description,reported_by_account_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at`,[
        incidentId,input.tripId,input.commandId,input.issueType,input.description,
        input.accountId])).rows[0]!;
      if(entering) {
        await db.query(`INSERT INTO trip_status_history
          (trip_id,version,previous_status,new_status,actor_type,actor_id)
          VALUES($1,$2,$3,'ERROR','USER',$4)`,[
          input.tripId,changed.version,row.status,input.accountId]);
        await db.query(`INSERT INTO trip_outbox
          (event_id,trip_id,aggregate_version,event_type,safe_payload)
          VALUES($1,$2,$3,'TRIP_ERROR','{}'::jsonb)`,[
          randomUUID(),input.tripId,changed.version]);
      }
      const response={incident:{incident_id:incidentId,trip_id:input.tripId,
        issue_type:input.issueType,description:input.description,status:'OPEN',
        reported_by_account_id:input.accountId,created_at:stamp(inserted.created_at)},
        trip:await this.dto(db,changed)};
      await this.save(db,input.commandId,input.tripId,'INCIDENT',digest,response);
      return response;
    });
  }
  async resolveReplay(input:{tripId:string;commandId:string;expected:string;action:string;
    note:string;accountId:string}):Promise<Data|undefined> {
    return this.internalReplay(input.commandId,'RESOLVE',input.tripId,
      hash([input.tripId,input.expected,input.action,input.note,input.accountId]));
  }
  async resolveError(input:{tripId:string;commandId:string;expected:string;action:string;
    note:string;accountId:string;eligibilityCheckedAt?:number}):Promise<Data> {
    const digest=hash([input.tripId,input.expected,input.action,input.note,input.accountId]);
    return this.transaction(async db=>{
      const row=(await db.query<Trip>('SELECT * FROM trip WHERE trip_id=$1 FOR UPDATE',
        [input.tripId])).rows[0];
      if(!row) throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
      const replay=await this.receipt(db,input.commandId,digest);
      if(replay) return replay;
      if(row.status!=='ERROR'||row.closed_at||!row.status_before_error)
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_RESOLVABLE');
      if(row.version!==input.expected)
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_VERSION_CONFLICT');
      if(input.action==='RESTORE_PREVIOUS_STATUS'&&
          (input.eligibilityCheckedAt===undefined||
          Date.now()-input.eligibilityCheckedAt>2000))
        throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_RESOLVABLE');
      const open=(await db.query<{incident_id:string}>(`SELECT incident_id FROM trip_incident
        WHERE trip_id=$1 AND status='OPEN' ORDER BY created_at,incident_id FOR UPDATE`,
        [input.tripId])).rows.map(item=>item.incident_id);
      if(!open.length) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_RESOLVABLE');
      const at=(await db.query<{at:Date}>('SELECT now() AS at')).rows[0]!.at;
      const restored=input.action==='RESTORE_PREVIOUS_STATUS';
      const changed=(await db.query<Trip>(restored?
        `UPDATE trip SET status=status_before_error,status_before_error=NULL,
          version=version+1,updated_at=$2 WHERE trip_id=$1 RETURNING *`:
        `UPDATE trip SET closed_at=$2,close_reason=$3,version=version+1,
          updated_at=$2 WHERE trip_id=$1 RETURNING *`,
        restored?[input.tripId,at]:[input.tripId,at,input.note])).rows[0]!;
      await db.query(`UPDATE trip_incident SET status='RESOLVED',resolution_action=$2,
        resolution_note=$3,resolved_by_account_id=$4,resolved_at=$5
        WHERE trip_id=$1 AND status='OPEN'`,[
        input.tripId,input.action,input.note,input.accountId,at]);
      if(restored) await db.query(`INSERT INTO trip_status_history
        (trip_id,version,previous_status,new_status,actor_type,actor_id,reason)
        VALUES($1,$2,'ERROR',$3,'USER',$4,$5)`,[
        input.tripId,changed.version,changed.status,input.accountId,input.note]);
      else await db.query(`INSERT INTO trip_closure(operation_id,trip_id,payment_fence)
        VALUES($1,$2,'PENDING')`,[randomUUID(),input.tripId]);
      await db.query(`INSERT INTO trip_resolution_audit
        (resolution_id,trip_id,actor_account_id,action,note,trip_version,resolved_incident_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7::uuid[])`,[
        randomUUID(),input.tripId,input.accountId,input.action,input.note,changed.version,open]);
      await db.query(`INSERT INTO trip_outbox
        (event_id,trip_id,aggregate_version,event_type,safe_payload)
        VALUES($1,$2,$3,$4,'{}'::jsonb)`,[
        randomUUID(),input.tripId,changed.version,
        restored?'TRIP_RECOVERED':'TRIP_CLOSED_ABNORMALLY']);
      const response={trip:{trip_id:input.tripId,trip_status:changed.status,
        version:changed.version,...(changed.status_before_error?
          {status_before_error:changed.status_before_error}:{}),
        ...(changed.closed_at?{closed_at:stamp(changed.closed_at),close_reason:input.note}:{}),
        updated_at:stamp(changed.updated_at)},resolved_incident_ids:open,
        resolution_action:input.action,resolved_at:stamp(at),
        resolved_by_account_id:input.accountId};
      await this.save(db,input.commandId,input.tripId,'RESOLVE',digest,response);
      return response;
    });
  }
  async hasBreakdownIncident(tripId:string):Promise<boolean> {
    const result=await this.pool.query<{found:boolean}>(`SELECT EXISTS (
      SELECT 1 FROM trip_incident WHERE trip_id=$1 AND issue_type='VEHICLE_BREAKDOWN'
    ) AS found`,[tripId]);
    return result.rows[0]?.found===true;
  }
  async closure(tripId:string):Promise<Data> {
    const trip=await this.find(tripId);
    if(!trip) throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
    if(!trip.closed_at) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_CLOSED');
    const found=await this.pool.query<{operation_id:string;driver_release:string;
      customer_release:string;created_at:Date;updated_at:Date}>(
      'SELECT * FROM trip_closure WHERE trip_id=$1',[tripId]);
    const row=found.rows[0];if(!row) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return {operation_id:row.operation_id,trip_id:tripId,
      status:row.driver_release==='CONFIRMED'&&row.customer_release==='CONFIRMED'
        ?'SUCCEEDED':'PROCESSING',driver_release:row.driver_release,
      customer_release:row.customer_release,created_at:stamp(row.created_at),
      updated_at:stamp(row.updated_at)};
  }
}
