import {readFileSync} from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import {facadeError} from '@cab/grpc-transport';
import type pg from 'pg';
import {normalizeRating} from '../domain/rating.js';
import {RatingLedger,type PageFilter} from './rating-ledger.js';
import {RatingOwners} from '../infrastructure/rating-owners.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
const id=(v:unknown)=>{if(typeof v!=='string'||!uuid.test(v))
  throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');return v;};
const date=(v:unknown):Date|undefined=>{if(v===undefined) return;
  if(!record(v)||typeof v.seconds!=='string'||!/^-?\d+$/.test(v.seconds)||
      typeof v.nanos!=='number'||!Number.isInteger(v.nanos)||
      v.nanos<0||v.nanos>=1e9)
    throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  const result=new Date(Number(v.seconds)*1000+Math.floor(v.nanos/1e6));
  if(!Number.isFinite(result.getTime())) throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
  return result;};
export class RatingCommands {
  readonly owners=new RatingOwners();
  readonly ledger:RatingLedger;
  constructor(pool:pg.Pool) {
    const file=process.env.CAB_RATING_CURSOR_KEY_FILE;
    if(!file) throw new Error('Rating cursor key configuration missing');
    let key:Buffer;try {key=Buffer.from(readFileSync(file,'utf8').trim(),'base64url');}
    catch {throw new Error('Rating cursor key unavailable');}
    if(key.length!==32) throw new Error('Rating cursor key invalid');
    this.ledger=new RatingLedger(pool,key);
  }
  close():void {this.owners.close();}
  async create(request:unknown,metadata:grpc.Metadata) {
    const input=record(request)?request:{};const tripId=id(input.trip_id);
    const commandId=id(input.command_id);
    let normalized;
    try {normalized=normalizeRating(input.score,input.comment);}
    catch {throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');}
    const principal=await this.owners.principal(metadata,['CUSTOMER']);
    const trip=await this.owners.tripContext(tripId,metadata);
    if(trip.customer_id!==principal.customerId)
      throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
    if(trip.trip_status!=='COMPLETED')
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_NOT_COMPLETED');
    const completed=date(trip.completed_at);
    if(!completed) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return this.ledger.create({tripId,customerId:principal.customerId!,
      driverId:String(trip.driver_id),tripVersion:String(trip.trip_version),
      verifiedAt:new Date()},normalized,commandId);
  }
  async get(request:unknown,metadata:grpc.Metadata) {
    const tripId=id(record(request)?request.trip_id:undefined);
    const principal=await this.owners.principal(metadata,['CUSTOMER','DRIVER','OPERATOR']);
    const trip=await this.owners.tripContext(tripId,metadata);
    if(principal.role==='CUSTOMER'&&trip.customer_id!==principal.customerId||
        principal.role==='DRIVER'&&trip.driver_id!==principal.driverId)
      throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
    return this.ledger.get(tripId);
  }
  private filters(request:unknown):Data {
    const value=record(request)?request:{};
    if(typeof value.limit!=='number'||!Number.isInteger(value.limit)||
        value.limit<1||value.limit>100||
        value.cursor!==undefined&&(typeof value.cursor!=='string'||!value.cursor||
          value.cursor.length>2048)||
        value.score!==undefined&&(typeof value.score!=='number'||
          !Number.isInteger(value.score)||value.score<1||value.score>5))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return value;
  }
  async driverList(request:unknown,metadata:grpc.Metadata) {
    const input=this.filters(request);
    if(input.trip_id!==undefined||input.driver_id!==undefined||
       input.from!==undefined||input.to!==undefined)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const principal=await this.owners.principal(metadata,['DRIVER']);
    return this.ledger.list({accountId:principal.accountId,scope:'DRIVER',
      driverId:principal.driverId!,limit:input.limit as number,
      score:input.score as number|undefined,cursor:input.cursor as string|undefined});
  }
  async operationsList(request:unknown,metadata:grpc.Metadata) {
    const input=this.filters(request);
    const principal=await this.owners.principal(metadata,['OPERATOR']);
    const filter:PageFilter={accountId:principal.accountId,scope:'OPERATOR',
      limit:input.limit as number,cursor:input.cursor as string|undefined,
      score:input.score as number|undefined};
    if(input.driver_id!==undefined) filter.driverId=id(input.driver_id);
    if(input.trip_id!==undefined) filter.tripId=id(input.trip_id);
    filter.from=date(input.from);filter.to=date(input.to);
    if(filter.from&&filter.to&&filter.from>=filter.to)
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_TIME_RANGE');
    return this.ledger.list(filter);
  }
}
