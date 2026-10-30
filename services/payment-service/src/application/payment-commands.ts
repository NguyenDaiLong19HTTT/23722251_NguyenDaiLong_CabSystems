import * as grpc from '@grpc/grpc-js';
import {readFileSync} from 'node:fs';
import {facadeError} from '@cab/grpc-transport';
import type pg from 'pg';
import {OwnerContext} from '../infrastructure/owner-context.js';
import {PaymentLedger,paymentDto,type Method} from './payment-ledger.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
const id=(value:unknown)=>{
  if (typeof value!=='string'||!uuid.test(value)) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return value;
};
const version=(value:unknown)=>{
  if (typeof value!=='string'||!/^[1-9][0-9]*$/.test(value))
    throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return value;
};
export class PaymentCommands {
  private readonly owners:OwnerContext;
  private readonly ledger:PaymentLedger;
  constructor(private readonly db:pg.Pool) {
    const file=process.env.CAB_PAYMENT_CURSOR_KEY_FILE;
    if (!file) throw new Error('Payment cursor key configuration missing');
    let key:Buffer;
    try {key=Buffer.from(readFileSync(file,'utf8').trim(),'base64url');}
    catch {throw new Error('Payment cursor key unavailable');}
    if (key.length!==32) throw new Error('Payment cursor key invalid');
    this.owners=new OwnerContext(db);this.ledger=new PaymentLedger(db,key);
  }
  close():void {this.owners.close();}
  async tripStartDecision(request:unknown):Promise<Data> {
    return this.ledger.tripStartDecision(id(record(request)?request.trip_id:undefined));
  }
  async recordTripCancellation(request:unknown):Promise<Data> {
    const data=record(request)?request:{};
    return this.ledger.recordTripCancellation(id(data.trip_id),id(data.cancellation_id));
  }
  async create(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const data=record(request)?request:{};
    const tripId=id(data.trip_id),method=data.payment_method;
    if (method!=='CASH'&&method!=='DEMO_TRANSFER')
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const key=this.owners.key(metadata),principal=await this.owners.principal(metadata);
    const trip=await this.owners.tripContext(tripId,metadata);
    this.owners.authorize(principal,trip,'CUSTOMER');
    if (trip.trip_status!=='COMPLETED') {
      const legacy=['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS']
        .includes(String(trip.trip_status))&&await this.ledger.findByTrip(tripId);
      if (!legacy) throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_PAYABLE');
    }
    const obligation=await this.owners.obligation(trip);
    if (principal.customerId!==obligation.customerId)
      throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
    return this.ledger.create(obligation,principal.accountId,key,method as Method);
  }
  async byTrip(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const tripId=id(record(request)?request.trip_id:undefined);
    const principal=await this.owners.principal(metadata);
    const trip=await this.owners.tripContext(tripId,metadata);
    this.owners.authorize(principal,trip,'READ');
    const row=await this.ledger.findByTrip(tripId);
    if (!row) throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
    return paymentDto(row);
  }
  async byId(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const paymentId=id(record(request)?request.payment_id:undefined);
    const principal=await this.owners.principal(metadata);
    const row=await this.ledger.find(paymentId);
    if (!row) throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
    const trip=await this.owners.tripContext(row.trip_id,metadata);
    this.owners.authorize(principal,trip,'READ');
    if (row.customer_id!==(trip.parties as Data).customer_id||
        row.driver_id!==(trip.parties as Data).driver_id)
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return paymentDto(row);
  }
  async attempts(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const data=record(request)?request:{};
    const paymentId=id(data.payment_id),limit=data.limit===undefined?20:Number(data.limit);
    if (!Number.isSafeInteger(limit)||limit<1||limit>100||
        data.cursor!==undefined&&typeof data.cursor!=='string')
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const principal=await this.owners.principal(metadata);
    if (principal.role==='DRIVER') throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const row=await this.ledger.find(paymentId);
    if (!row) throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
    const trip=await this.owners.tripContext(row.trip_id,metadata);
    this.owners.authorize(principal,trip,'READ');
    if (row.customer_id!==(trip.parties as Data).customer_id||
        row.driver_id!==(trip.parties as Data).driver_id)
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return this.ledger.listAttempts(paymentId,principal.accountId,limit,
      typeof data.cursor==='string'?data.cursor:undefined);
  }
  async fare(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const tripId=id(record(request)?request.trip_id:undefined);
    const principal=await this.owners.principal(metadata);
    const trip=await this.owners.tripContext(tripId,metadata);
    this.owners.authorize(principal,trip,'READ');
    const result=await this.db.query<{fare_id:string;trip_id:string;pricing_version_id:string;
      route_id:string;route_version:string;distance_meters:string;amount_vnd:string;
      created_at:Date}>(`SELECT fare_id,trip_id,pricing_version_id,route_id,route_version,
      distance_meters,amount_vnd,created_at FROM fare WHERE trip_id=$1`,[tripId]);
    const row=result.rows[0];
    if (!row) throw fail(grpc.status.FAILED_PRECONDITION,'FARE_NOT_READY');
    return {fare_id:row.fare_id,trip_id:row.trip_id,pricing_version_id:row.pricing_version_id,
      route_id:row.route_id,route_version:row.route_version,
      distance_meters:row.distance_meters,total_amount:row.amount_vnd,currency:'VND',
      calculated_at:{seconds:String(Math.floor(row.created_at.getTime()/1000)),
        nanos:(row.created_at.getTime()%1000)*1e6}};
  }
  async confirmCash(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const data=record(request)?request:{};
    const paymentId=id(data.payment_id),expected=version(data.expected_version);
    const key=this.owners.key(metadata),principal=await this.owners.principal(metadata);
    if (principal.role!=='DRIVER') throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const row=await this.ledger.find(paymentId);
    if (!row) throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
    const trip=await this.owners.tripContext(row.trip_id,metadata);
    this.owners.authorize(principal,trip,'DRIVER');
    return this.ledger.confirmCash(paymentId,principal.accountId,principal.driverId!,key,
      expected,trip.trip_status==='COMPLETED');
  }
  async retry(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const data=record(request)?request:{};
    const paymentId=id(data.payment_id),expected=version(data.expected_version);
    if (data.payment_method!=='CASH'&&data.payment_method!=='DEMO_TRANSFER')
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const key=this.owners.key(metadata),principal=await this.owners.principal(metadata);
    if (principal.role!=='CUSTOMER') throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const row=await this.ledger.find(paymentId);
    if (!row) throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
    const trip=await this.owners.tripContext(row.trip_id,metadata);
    this.owners.authorize(principal,trip,'CUSTOMER');
    return this.ledger.retry(paymentId,principal.customerId!,principal.accountId,key,
      expected,data.payment_method as Method);
  }
  async demoResult(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const enabled=process.env.NODE_ENV==='development'&&
      process.env.CAB_DEMO_PAYMENT_RESULT_ENABLED==='1';
    if (!enabled) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const data=record(request)?request:{};
    const paymentId=id(data.payment_id),attemptId=id(data.attempt_id),
      expected=version(data.expected_version);
    const amount=data.expected_amount,currency=data.currency;
    const outcome=data.outcome==='DEMO_SUCCESS'?'SUCCESS':
      data.outcome==='DEMO_FAILED'?'FAILED':undefined;
    if (typeof amount!=='string'||!/^(0|[1-9][0-9]*)$/.test(amount)||
        currency!=='VND'||!outcome) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const key=this.owners.key(metadata),principal=await this.owners.principal(metadata);
    if (principal.role!=='CUSTOMER') throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const row=await this.ledger.find(paymentId);
    if (!row) throw fail(grpc.status.NOT_FOUND,'PAYMENT_NOT_FOUND');
    const trip=await this.owners.tripContext(row.trip_id,metadata);
    this.owners.authorize(principal,trip,'CUSTOMER');
    return this.ledger.result(paymentId,principal.customerId!,principal.accountId,
      attemptId,key,expected,
      amount,currency,outcome,enabled);
  }
}
