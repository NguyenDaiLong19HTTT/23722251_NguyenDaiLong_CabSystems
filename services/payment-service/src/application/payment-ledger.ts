import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {facadeError} from '@cab/grpc-transport';
import type pg from 'pg';

export type Method='CASH'|'DEMO_TRANSFER';
export type VerifiedObligation={tripId:string;bookingId:string;customerId:string;
  driverId:string;customerAccountId:string;driverAccountId:string;
  pricingVersionId:string;routeId:string;routeVersion:string;
  distanceMeters:string;amountVnd:string;pricingSnapshot:Record<string,unknown>};
type PaymentRow={payment_id:string;fare_id:string;trip_id:string;customer_id:string;
  driver_id:string;customer_account_id:string;driver_account_id:string;
  amount_vnd:string;currency:string;method:Method;status:string;
  version:string;current_attempt_id:string;requires_review:boolean;paid_at:Date|null;
  confirmed_by_account_id:string|null;created_at:Date;updated_at:Date};
type Receipt={request_digest:Buffer;response_snapshot:Record<string,unknown>;http_status:number};
type AttemptRow={attempt_id:string;payment_id:string;attempt_number:number;
  method:Method;status:string;amount_vnd:string;merchant_reference:string|null;
  resolved_at:Date|null;created_at:Date;updated_at:Date;
  confirmed_by_account_id:string|null};
const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest();
const keyPattern=/^[A-Za-z0-9._:-]{1,128}$/;
export function paymentDto(row:PaymentRow):Record<string,unknown> {
  const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
    nanos:(date.getTime()%1000)*1e6});
  return {payment_id:row.payment_id,trip_id:row.trip_id,fare_id:row.fare_id,
    customer_id:row.customer_id,amount:row.amount_vnd,currency:'VND',method:row.method,
    payment_status:`PAYMENT_${row.status}`,current_attempt_id:row.current_attempt_id,
    requires_review:row.requires_review,version:row.version,
    created_at:stamp(row.created_at),updated_at:stamp(row.updated_at),
    ...(row.paid_at?{paid_at:stamp(row.paid_at)}:{}),
    ...(row.confirmed_by_account_id?{confirmed_by_account_id:row.confirmed_by_account_id}:{})};
}

export class PaymentLedger {
  constructor(private readonly pool:pg.Pool,private readonly cursorKey?:Buffer) {}
  private cursor(accountId:string,paymentId:string,limit:number,after:number):string {
    if (!this.cursorKey) throw new Error('Payment cursor key missing');
    const body=Buffer.from(JSON.stringify({a:accountId,p:paymentId,l:limit,n:after,
      e:Date.now()+15*60*1000})).toString('base64url');
    const mac=createHmac('sha256',this.cursorKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }
  private after(cursor:string|undefined,accountId:string,paymentId:string,limit:number):number {
    if (!cursor) return 0;
    if (!this.cursorKey||cursor.length>512||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(cursor))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const [body,mac]=cursor.split('.');
    const actual=createHmac('sha256',this.cursorKey).update(body!).digest();
    const supplied=Buffer.from(mac!,'base64url');
    if (supplied.length!==actual.length||!timingSafeEqual(supplied,actual))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    let parsed:Record<string,unknown>;
    try {parsed=JSON.parse(Buffer.from(body!,'base64url').toString('utf8'));}
    catch {throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');}
    if (parsed.a!==accountId||parsed.p!==paymentId||parsed.l!==limit||
        !Number.isSafeInteger(parsed.n)||Number(parsed.n)<1||
        !Number.isSafeInteger(parsed.e)||Number(parsed.e)<=Date.now())
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return Number(parsed.n);
  }
  async listAttempts(paymentId:string,accountId:string,limit:number,
    cursor?:string):Promise<Record<string,unknown>> {
    if (!Number.isInteger(limit)||limit<1||limit>100)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const after=this.after(cursor,accountId,paymentId,limit);
    const result=await this.pool.query<AttemptRow>(`SELECT a.attempt_id,a.payment_id,
      a.attempt_number,a.method,a.status,a.amount_vnd,a.merchant_reference,
      a.resolved_at,a.created_at,a.updated_at,p.confirmed_by_account_id
      FROM payment_attempt a JOIN payment p ON p.payment_id=a.payment_id
      WHERE a.payment_id=$1 AND a.attempt_number>$2
      ORDER BY a.attempt_number ASC LIMIT $3`,[paymentId,after,limit+1]);
    const rows=result.rows.slice(0,limit);
    const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
      nanos:(date.getTime()%1000)*1e6});
    const items=rows.map(row=>({attempt_id:row.attempt_id,payment_id:row.payment_id,
      attempt_number:row.attempt_number,method:row.method,amount:row.amount_vnd,
      currency:'VND',status:`PAYMENT_${row.status}`,
      ...(row.merchant_reference?{merchant_reference:row.merchant_reference}:{}),
      ...(row.resolved_at?{resolved_at:stamp(row.resolved_at)}:{}),
      ...(row.method==='CASH'&&row.status==='SUCCESS'&&row.confirmed_by_account_id
        ?{confirmed_by_account_id:row.confirmed_by_account_id}:{}),
      created_at:stamp(row.created_at),updated_at:stamp(row.updated_at)}));
    return {items,...(result.rows.length>limit
      ?{next_cursor:this.cursor(accountId,paymentId,limit,rows.at(-1)!.attempt_number)}:{})};
  }
  private async transaction<T>(work:(db:pg.PoolClient)=>Promise<T>):Promise<T> {
    const db=await this.pool.connect();
    try {await db.query('BEGIN');const value=await work(db);await db.query('COMMIT');return value;}
    catch(error) {await db.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally {db.release();}
  }
  private async receipt(db:pg.PoolClient,accountId:string,operation:string,
    resourceId:string,key:string,hash:Buffer):Promise<Receipt|undefined> {
    const found=await db.query<Receipt>(`SELECT request_digest,response_snapshot,http_status
      FROM payment_receipt WHERE account_id=$1 AND operation=$2 AND resource_id=$3
        AND idempotency_key=$4`,[accountId,operation,resourceId,key]);
    const row=found.rows[0];
    if (row&&!row.request_digest.equals(hash)) throw fail(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
    return row;
  }
  private async saveReceipt(db:pg.PoolClient,accountId:string,operation:string,
    resourceId:string,key:string,hash:Buffer,httpStatus:number,response:Record<string,unknown>) {
    await db.query(`INSERT INTO payment_receipt
      (receipt_id,account_id,operation,resource_id,idempotency_key,request_digest,http_status,response_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[
      randomUUID(),accountId,operation,resourceId,key,hash,httpStatus,JSON.stringify(response)]);
  }
  async create(obligation:VerifiedObligation,accountId:string,key:string,method:Method):Promise<Record<string,unknown>> {
    if (!keyPattern.test(key)||!['CASH','DEMO_TRANSFER'].includes(method))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    if (obligation.customerAccountId!==accountId)
      throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const hash=digest([obligation.tripId,method]);
    return this.transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[obligation.tripId]);
      const prior=await this.receipt(db,accountId,'CREATE',obligation.tripId,key,hash);
      if (prior) return prior.response_snapshot;
      const cancellation=await db.query('SELECT 1 FROM payment_trip_cancellation WHERE trip_id=$1',
        [obligation.tripId]);
      if (cancellation.rowCount) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_CANCELLED');
      const exists=await db.query('SELECT 1 FROM payment WHERE trip_id=$1',[obligation.tripId]);
      if (exists.rowCount) throw fail(grpc.status.ALREADY_EXISTS,'PAYMENT_ALREADY_EXISTS');
      const fareId=randomUUID(),paymentId=randomUUID(),attemptId=randomUUID();
      await db.query(`INSERT INTO fare(fare_id,trip_id,booking_id,customer_id,driver_id,
        customer_account_id,driver_account_id,
        pricing_version_id,route_id,route_version,distance_meters,amount_vnd,pricing_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,[
        fareId,obligation.tripId,obligation.bookingId,obligation.customerId,
        obligation.driverId,obligation.customerAccountId,obligation.driverAccountId,
        obligation.pricingVersionId,obligation.routeId,
        obligation.routeVersion,obligation.distanceMeters,obligation.amountVnd,
        JSON.stringify(obligation.pricingSnapshot)]);
      const created=await db.query<PaymentRow>(`INSERT INTO payment
        (payment_id,fare_id,trip_id,customer_id,driver_id,customer_account_id,
         driver_account_id,amount_vnd,currency,
         method,status,version,current_attempt_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'VND',$9,'PENDING',1,$10) RETURNING *`,[
        paymentId,fareId,obligation.tripId,obligation.customerId,obligation.driverId,
        obligation.customerAccountId,obligation.driverAccountId,
        obligation.amountVnd,method,attemptId]);
      await db.query(`INSERT INTO payment_attempt
        (attempt_id,payment_id,attempt_number,method,status,amount_vnd,merchant_reference)
        VALUES($1,$2,1,$3,'PENDING',$4,$5)`,[
        attemptId,paymentId,method,obligation.amountVnd,
        method==='DEMO_TRANSFER'?randomUUID():null]);
      const response=paymentDto(created.rows[0]!);
      await this.saveReceipt(db,accountId,'CREATE',obligation.tripId,key,hash,201,response);
      return response;
    });
  }
  async result(paymentId:string,customerId:string,accountId:string,attemptId:string,key:string,
    expectedVersion:string,amount:string,currency:string,outcome:'SUCCESS'|'FAILED',
    demoEnabled:boolean):Promise<Record<string,unknown>> {
    if (!demoEnabled) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    if (!keyPattern.test(key)||!['SUCCESS','FAILED'].includes(outcome)||
        !/^[1-9][0-9]*$/.test(expectedVersion)||!/^(0|[1-9][0-9]*)$/.test(amount)||
        currency!=='VND') throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const hash=digest([paymentId,attemptId,expectedVersion,amount,currency,outcome]);
    return this.transaction(async db=>{
      const locked=await db.query<PaymentRow>('SELECT * FROM payment WHERE payment_id=$1 FOR UPDATE',[paymentId]);
      const row=locked.rows[0];
      if (!row||row.customer_id!==customerId||row.customer_account_id!==accountId)
        throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
      const prior=await this.receipt(db,accountId,'DEMO_RESULT',paymentId,key,hash);
      if (prior) return prior.response_snapshot;
      const cancellation=await db.query('SELECT 1 FROM payment_trip_cancellation WHERE trip_id=$1',
        [row.trip_id]);
      if (cancellation.rowCount) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_CANCELLED');
      if (row.current_attempt_id!==attemptId)
        throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_ATTEMPT_CONFLICT');
      if (row.method!=='DEMO_TRANSFER'||row.status!=='PENDING'||row.requires_review)
        throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_PENDING');
      if (row.version!==expectedVersion) throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_VERSION_CONFLICT');
      if (row.amount_vnd!==amount||row.currency!==currency)
        throw fail(grpc.status.INVALID_ARGUMENT,'PAYMENT_AMOUNT_MISMATCH');
      await db.query(`UPDATE payment_attempt SET status=$2,resolved_at=now(),updated_at=now()
        WHERE attempt_id=$1 AND status='PENDING'`,[row.current_attempt_id,outcome]);
      const changed=await db.query<PaymentRow>(`UPDATE payment SET status=$2,version=version+1,
        paid_at=CASE WHEN $2='SUCCESS' THEN now() ELSE NULL END,updated_at=now()
        WHERE payment_id=$1 AND status='PENDING' RETURNING *`,[paymentId,outcome]);
      if (!changed.rows[0]) throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_PENDING');
      const response=paymentDto(changed.rows[0]);
      await db.query(`INSERT INTO payment_outbox
        (event_id,payment_id,aggregate_version,event_type,safe_payload)
        VALUES($1,$2,$3,$4,$5::jsonb)`,[
        randomUUID(),paymentId,changed.rows[0].version,
        outcome==='SUCCESS'?'PAYMENT_SUCCESS':'PAYMENT_FAILED',
        JSON.stringify({paymentId,attemptId:row.current_attempt_id,amount,currency})]);
      await this.saveReceipt(db,accountId,'DEMO_RESULT',paymentId,key,hash,200,response);
      return response;
    });
  }
  async confirmCash(paymentId:string,accountId:string,driverId:string,key:string,
    expectedVersion:string,tripCompleted:boolean):Promise<Record<string,unknown>> {
    if (!keyPattern.test(key)||!/^[1-9][0-9]*$/.test(expectedVersion))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const hash=digest([paymentId,expectedVersion]);
    return this.transaction(async db=>{
      const locked=await db.query<PaymentRow>('SELECT * FROM payment WHERE payment_id=$1 FOR UPDATE',[paymentId]);
      const row=locked.rows[0];
      if (!row||row.driver_id!==driverId||row.driver_account_id!==accountId)
        throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
      const prior=await this.receipt(db,accountId,'CONFIRM_CASH',paymentId,key,hash);
      if (prior) return prior.response_snapshot;
      const cancellation=await db.query('SELECT 1 FROM payment_trip_cancellation WHERE trip_id=$1',
        [row.trip_id]);
      if (cancellation.rowCount) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_CANCELLED');
      if (!tripCompleted) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_COMPLETED');
      if (row.method!=='CASH') throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_CASH');
      if (row.status==='SUCCESS') throw fail(grpc.status.ALREADY_EXISTS,'PAYMENT_ALREADY_PAID');
      if (row.status!=='PENDING'||row.requires_review)
        throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_PENDING');
      if (row.version!==expectedVersion) throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_VERSION_CONFLICT');
      await db.query(`UPDATE payment_attempt SET status='SUCCESS',resolved_at=now(),updated_at=now()
        WHERE attempt_id=$1 AND status='PENDING'`,[row.current_attempt_id]);
      const changed=await db.query<PaymentRow>(`UPDATE payment SET status='SUCCESS',
        version=version+1,paid_at=now(),confirmed_by_account_id=$2,updated_at=now()
        WHERE payment_id=$1 AND status='PENDING' RETURNING *`,[paymentId,accountId]);
      if (!changed.rows[0]) throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_PENDING');
      const response=paymentDto(changed.rows[0]);
      await db.query(`INSERT INTO payment_outbox
        (event_id,payment_id,aggregate_version,event_type,safe_payload)
        VALUES($1,$2,$3,'PAYMENT_SUCCESS',$4::jsonb)`,[
        randomUUID(),paymentId,changed.rows[0].version,
        JSON.stringify({paymentId,attemptId:row.current_attempt_id,
          amount:row.amount_vnd,currency:'VND'})]);
      await this.saveReceipt(db,accountId,'CONFIRM_CASH',paymentId,key,hash,200,response);
      return response;
    });
  }
  async find(paymentId:string):Promise<PaymentRow|undefined> {
    const result=await this.pool.query<PaymentRow>('SELECT * FROM payment WHERE payment_id=$1',[paymentId]);
    return result.rows[0];
  }
  async findByTrip(tripId:string):Promise<PaymentRow|undefined> {
    const result=await this.pool.query<PaymentRow>('SELECT * FROM payment WHERE trip_id=$1',[tripId]);
    return result.rows[0];
  }
  async tripStartDecision(tripId:string):Promise<Record<string,unknown>> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tripId))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const row=await this.findByTrip(tripId);
    if (!row) throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
    const cancellation=await this.pool.query('SELECT 1 FROM payment_trip_cancellation WHERE trip_id=$1',
      [tripId]);
    const canStart=!row.requires_review&&!cancellation.rowCount&&(
      row.method==='CASH'&&row.status==='PENDING'||
      row.method==='DEMO_TRANSFER'&&row.status==='SUCCESS');
    return {trip_id:tripId,payment_id:row.payment_id,
      method:`TRIP_PAYMENT_${row.method}`,
      status:`TRIP_PAYMENT_${row.status}`,can_start_trip:canStart,
      requires_review:row.requires_review,version:row.version};
  }
  async recordTripCancellation(tripId:string,cancellationId:string):Promise<Record<string,unknown>> {
    const isUuid=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid(tripId)||!isUuid(cancellationId))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return this.transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[tripId]);
      const existing=await db.query<{cancellation_id:string}>(
        'SELECT cancellation_id FROM payment_trip_cancellation WHERE trip_id=$1',[tripId]);
      if (existing.rows[0]&&existing.rows[0].cancellation_id!==cancellationId)
        throw fail(grpc.status.ALREADY_EXISTS,'TRIP_CANCELLATION_CONFLICT');
      if (!existing.rows[0]) await db.query(`INSERT INTO payment_trip_cancellation
        (trip_id,cancellation_id) VALUES($1,$2)`,[tripId,cancellationId]);
      const locked=await db.query<PaymentRow>('SELECT * FROM payment WHERE trip_id=$1 FOR UPDATE',
        [tripId]);
      const payment=locked.rows[0];
      if (payment?.status==='SUCCESS'&&!payment.requires_review) {
        const changed=await db.query<PaymentRow>(`UPDATE payment SET requires_review=TRUE,
          version=version+1,updated_at=now() WHERE payment_id=$1 RETURNING *`,
          [payment.payment_id]);
        await db.query(`INSERT INTO payment_outbox
          (event_id,payment_id,aggregate_version,event_type,safe_payload)
          VALUES($1,$2,$3,'PAYMENT_REVIEW_REQUIRED',$4::jsonb)`,[
          randomUUID(),payment.payment_id,changed.rows[0]!.version,
          JSON.stringify({attemptId:payment.current_attempt_id})]);
        return {trip_id:tripId,cancellation_id:cancellationId,
          review_recorded:true,payment_id:payment.payment_id};
      }
      return {trip_id:tripId,cancellation_id:cancellationId,
        review_recorded:Boolean(payment?.requires_review),
        ...(payment?{payment_id:payment.payment_id}:{})};
    });
  }
  async retry(paymentId:string,customerId:string,accountId:string,key:string,
    expectedVersion:string,method:Method):Promise<Record<string,unknown>> {
    if (!keyPattern.test(key)||!/^[1-9][0-9]*$/.test(expectedVersion)||
        !['CASH','DEMO_TRANSFER'].includes(method))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const hash=digest([paymentId,expectedVersion,method]);
    return this.transaction(async db=>{
      const locked=await db.query<PaymentRow>('SELECT * FROM payment WHERE payment_id=$1 FOR UPDATE',[paymentId]);
      const row=locked.rows[0];
      if (!row||row.customer_id!==customerId||row.customer_account_id!==accountId)
        throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
      const prior=await this.receipt(db,accountId,'RETRY',paymentId,key,hash);
      if (prior) return prior.response_snapshot;
      const cancellation=await db.query('SELECT 1 FROM payment_trip_cancellation WHERE trip_id=$1',
        [row.trip_id]);
      if (cancellation.rowCount) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_CANCELLED');
      if (row.status==='UNKNOWN') throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_REQUIRES_RECONCILIATION');
      if (row.requires_review) throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_REQUIRES_REVIEW');
      if (row.status!=='FAILED') throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_RETRYABLE');
      if (row.version!==expectedVersion) throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_VERSION_CONFLICT');
      const attempts=await db.query<{next_number:string}>(`SELECT COALESCE(max(attempt_number),0)+1 AS next_number
        FROM payment_attempt WHERE payment_id=$1`,[paymentId]);
      const attemptId=randomUUID();
      await db.query(`INSERT INTO payment_attempt
        (attempt_id,payment_id,attempt_number,method,status,amount_vnd,merchant_reference)
        VALUES($1,$2,$3,$4,'PENDING',$5,$6)`,[
        attemptId,paymentId,attempts.rows[0]!.next_number,method,row.amount_vnd,
        method==='DEMO_TRANSFER'?randomUUID():null]);
      const changed=await db.query<PaymentRow>(`UPDATE payment SET status='PENDING',method=$2,
        version=version+1,current_attempt_id=$3,updated_at=now()
        WHERE payment_id=$1 AND status='FAILED' RETURNING *`,[paymentId,method,attemptId]);
      if (!changed.rows[0]) throw fail(grpc.status.FAILED_PRECONDITION,'PAYMENT_NOT_RETRYABLE');
      const response=paymentDto(changed.rows[0]);
      await this.saveReceipt(db,accountId,'RETRY',paymentId,key,hash,202,response);
      return response;
    });
  }
}
