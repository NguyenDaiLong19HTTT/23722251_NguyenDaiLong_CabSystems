import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {facadeError} from '@cab/grpc-transport';
import type pg from 'pg';
import type {RatingInput} from '../domain/rating.js';

type RatingRow={rating_id:string;trip_id:string;customer_id:string;driver_id:string;
  score:number;comment:string|null;trip_version:bigint;trip_verified_at:Date;created_at:Date};
type Receipt={command_id:string;trip_id:string;request_digest:Buffer;rating_id:string};
export type RatingContext={tripId:string;customerId:string;driverId:string;
  tripVersion:string;verifiedAt:Date};
export type PageFilter={accountId:string;scope:'DRIVER'|'OPERATOR';driverId?:string;
  tripId?:string;score?:number;from?:Date;to?:Date;limit:number;cursor?:string};
const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
const dto=(row:RatingRow)=>({rating_id:row.rating_id,trip_id:row.trip_id,
  customer_id:row.customer_id,driver_id:row.driver_id,score:row.score,
  ...(row.comment?{comment:row.comment}:{}),created_at:stamp(row.created_at)});
const digest=(input:RatingInput)=>createHash('sha256')
  .update(JSON.stringify([input.score,input.comment])).digest();

export class RatingLedger {
  constructor(private readonly pool:pg.Pool,private readonly cursorKey:Buffer) {}
  async create(context:RatingContext,input:RatingInput,commandId:string) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[context.tripId]);
      const hash=digest(input);
      const receipt=await client.query<Receipt>(
        'SELECT * FROM rating_receipt WHERE command_id=$1',[commandId]);
      if(receipt.rows[0]&&(receipt.rows[0].trip_id!==context.tripId||
          !timingSafeEqual(receipt.rows[0].request_digest,hash)))
        throw fail(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
      const existing=await client.query<RatingRow>(
        'SELECT * FROM rating WHERE trip_id=$1',[context.tripId]);
      let row=existing.rows[0];
      if(row) {
        if(row.customer_id!==context.customerId||row.driver_id!==context.driverId||
            row.score!==input.score||row.comment!==input.comment)
          throw fail(grpc.status.ALREADY_EXISTS,'RATING_ALREADY_EXISTS');
      } else {
        const created=await client.query<RatingRow>(`INSERT INTO rating
          (rating_id,trip_id,customer_id,driver_id,score,comment,trip_version,trip_verified_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[
          randomUUID(),context.tripId,context.customerId,context.driverId,input.score,
          input.comment,context.tripVersion,context.verifiedAt]);
        row=created.rows[0]!;
        await client.query(`INSERT INTO rating_audit
          (audit_id,rating_id,trip_id,customer_id,trip_version,trip_verified_at)
          VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),row.rating_id,context.tripId,
          context.customerId,context.tripVersion,context.verifiedAt]);
      }
      if(!receipt.rows[0]) await client.query(`INSERT INTO rating_receipt
        (command_id,trip_id,request_digest,rating_id) VALUES($1,$2,$3,$4)`,[
        commandId,context.tripId,hash,row.rating_id]);
      await client.query('COMMIT');
      return dto(row);
    } catch(error) {await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally {client.release();}
  }
  async get(tripId:string) {
    const rows=await this.pool.query<RatingRow>('SELECT * FROM rating WHERE trip_id=$1',[tripId]);
    if(!rows.rows[0]) throw fail(grpc.status.NOT_FOUND,'RATING_NOT_FOUND');
    return dto(rows.rows[0]);
  }
  private encode(value:object):string {
    const data=Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature=createHmac('sha256',this.cursorKey).update(data).digest('base64url');
    return `${data}.${signature}`;
  }
  private decode(cursor:string):Record<string,unknown> {
    const parts=cursor.split('.');
    if(parts.length!==2||parts[0]!.length>1800||parts[1]!.length!==43)
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    const expected=createHmac('sha256',this.cursorKey).update(parts[0]!).digest();
    const supplied=Buffer.from(parts[1]!,'base64url');
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))
      throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
    try {const value=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'));
      if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error();
      return value as Record<string,unknown>;
    } catch {throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');}
  }
  async list(filter:PageFilter) {
    const scope=JSON.stringify([filter.accountId,filter.scope,filter.driverId??null,
      filter.tripId??null,filter.score??null,filter.from?.toISOString()??null,
      filter.to?.toISOString()??null,filter.limit]);
    let after:Date|undefined,lastId:string|undefined;
    if(filter.cursor) {
      const cursor=this.decode(filter.cursor);
      if(cursor.scope!==scope||typeof cursor.at!=='string'||
          typeof cursor.id!=='string'||!/^[0-9a-f-]{36}$/i.test(cursor.id)||
          !Number.isFinite(Date.parse(cursor.at)))
        throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
      if(typeof cursor.expires!=='number'||cursor.expires<Date.now())
        throw fail(grpc.status.INVALID_ARGUMENT,'CURSOR_EXPIRED');
      after=new Date(cursor.at);lastId=cursor.id;
    }
    const parts:string[]=['1=1'];const params:unknown[]=[];
    const add=(fragment:string,value:unknown)=>{params.push(value);
      parts.push(fragment.replace('?',`$${params.length}`));};
    if(filter.driverId) add('driver_id=?',filter.driverId);
    if(filter.tripId) add('trip_id=?',filter.tripId);
    if(filter.score!==undefined) add('score=?',filter.score);
    if(filter.from) add('created_at>=?',filter.from);
    if(filter.to) add('created_at<?',filter.to);
    if(after&&lastId) {params.push(after,lastId);
      parts.push(`(created_at,rating_id)<($${params.length-1},$${params.length})`);}
    params.push(filter.limit+1);
    const rows=await this.pool.query<RatingRow>(`SELECT * FROM rating WHERE ${parts.join(' AND ')}
      ORDER BY created_at DESC,rating_id DESC LIMIT $${params.length}`,params);
    const hasMore=rows.rows.length>filter.limit;
    const items=rows.rows.slice(0,filter.limit);
    const last=items.at(-1);
    return {items:items.map(dto),...(hasMore&&last?{next_cursor:this.encode({scope,
      at:last.created_at.toISOString(),id:last.rating_id,expires:Date.now()+3600000})}:{})};
  }
}
