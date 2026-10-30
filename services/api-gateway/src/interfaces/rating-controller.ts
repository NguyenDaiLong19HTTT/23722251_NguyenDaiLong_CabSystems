import {randomUUID} from 'node:crypto';
import {Controller,Get,Param,Post,Query,Req,Res} from '@nestjs/common';
import type {Request,Response} from 'express';
import * as grpc from '@grpc/grpc-js';
import {decodeFacadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {GatewayGrpcClients} from '../infrastructure/grpc-clients.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const definition=serviceDefinition('cab.gateway.v1.RatingFacadeService',
  'proto/cab/gateway/v1/rating_facade.proto');
const errors:Record<string,{http:number;code:grpc.status}>={
  VALIDATION_ERROR:{http:400,code:grpc.status.INVALID_ARGUMENT},
  INVALID_CURSOR:{http:400,code:grpc.status.INVALID_ARGUMENT},
  CURSOR_EXPIRED:{http:400,code:grpc.status.INVALID_ARGUMENT},
  INVALID_TIME_RANGE:{http:400,code:grpc.status.INVALID_ARGUMENT},
  UNAUTHENTICATED:{http:401,code:grpc.status.UNAUTHENTICATED},
  FORBIDDEN:{http:403,code:grpc.status.PERMISSION_DENIED},
  TRIP_NOT_FOUND:{http:404,code:grpc.status.NOT_FOUND},
  RATING_NOT_FOUND:{http:404,code:grpc.status.NOT_FOUND},
  TRIP_NOT_COMPLETED:{http:409,code:grpc.status.FAILED_PRECONDITION},
  RATING_ALREADY_EXISTS:{http:409,code:grpc.status.ALREADY_EXISTS},
  IDEMPOTENCY_CONFLICT:{http:409,code:grpc.status.ALREADY_EXISTS},
};
function iso(value:unknown):string {
  if(!record(value)||typeof value.seconds!=='string'||!/^\d+$/.test(value.seconds)||
      typeof value.nanos!=='number'||!Number.isInteger(value.nanos)||
      value.nanos<0||value.nanos>=1e9) throw new Error('Invalid Rating timestamp');
  const date=new Date(Number(value.seconds)*1000+Math.floor(value.nanos/1e6));
  if(!Number.isFinite(date.getTime())) throw new Error('Invalid Rating timestamp');
  return date.toISOString();
}
function view(value:unknown):Data {
  if(!record(value)||![value.rating_id,value.trip_id,value.customer_id,value.driver_id]
      .every(item=>typeof item==='string'&&uuid.test(item))||
      typeof value.score!=='number'||!Number.isInteger(value.score)||
      value.score<1||value.score>5||
      value.comment!==undefined&&(typeof value.comment!=='string'||
        !value.comment||value.comment.length>1000||value.comment!==value.comment.trim()))
    throw new Error('Invalid Rating response');
  return {ratingId:value.rating_id,tripId:value.trip_id,customerId:value.customer_id,
    driverId:value.driver_id,score:value.score,
    ...(value.comment?{comment:value.comment}:{}),createdAt:iso(value.created_at)};
}
function page(value:unknown):Data {
  if(!record(value)) throw new Error('Invalid Rating page');
  const items=value.items??[];
  if(!Array.isArray(items)||value.next_cursor!==undefined&&
      (typeof value.next_cursor!=='string'||!value.next_cursor))
    throw new Error('Invalid Rating page');
  return {items:items.map(view),nextCursor:value.next_cursor??null};
}
function timestamp(text:string):Data|undefined {
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(text)) return;
  const value=Date.parse(text);if(!Number.isFinite(value)) return;
  return {seconds:String(Math.floor(value/1000)),nanos:(value%1000)*1e6};
}
@Controller('v1')
export class RatingController {
  constructor(private readonly clients:GatewayGrpcClients) {}
  private invalid(res:Response):void {res.setHeader('Cache-Control','no-store');
    res.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});}
  private async call(method:string,body:Data,req:Request,res:Response):Promise<Data|undefined> {
    res.setHeader('Cache-Control','no-store');
    const token=req.header('Authorization');
    if(!token||!/^Bearer [^\s]+$/.test(token)) {
      res.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return;}
    try {const target=process.env.RATING_SERVICE_GRPC_TARGET;
      if(!target) throw new Error('Rating target missing');
      const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
      metadata.set('x-cab-user-authorization',token);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),'rating-service');
      return await unaryCall<Data,Data>(client,definition,method,body,metadata,4000);
    } catch(error) {const detail=decodeFacadeError(error as grpc.ServiceError);
      const mapped=detail?errors[detail.reason]:undefined;
      const valid=mapped&&mapped.code===detail?.code&&
        (detail?.reason!=='UNAUTHENTICATED'||detail.origin==='END_USER');
      res.status(valid?mapped.http:503).json({errorCode:valid?detail.reason:'SERVICE_UNAVAILABLE',
        message:valid?'Request could not be completed':'Service temporarily unavailable'});
      return;}
  }
  @Post('trips/:tripId/rating')
  async create(@Param('tripId') tripId:string,@Req() req:Request,@Res() res:Response) {
    const body=req.body;
    if(!uuid.test(tripId)||!record(body)||Object.keys(body).some(key=>
        !['score','comment'].includes(key))||typeof body.score!=='number'||
        !Number.isInteger(body.score)||body.score<1||body.score>5||
        body.comment!==undefined&&(typeof body.comment!=='string'||body.comment.length>1000))
      return this.invalid(res);
    const result=await this.call('CreateTripRating',{trip_id:tripId,score:body.score,
      ...(body.comment!==undefined?{comment:body.comment}:{}),command_id:randomUUID()},req,res);
    if(!result) return;
    try {const output=view(result);res.setHeader('Location',`/v1/trips/${tripId}/rating`);
      res.status(201).json(output);}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('trips/:tripId/rating')
  async get(@Param('tripId') tripId:string,@Req() req:Request,@Res() res:Response) {
    if(!uuid.test(tripId)) return this.invalid(res);
    const result=await this.call('GetTripRating',{trip_id:tripId},req,res);
    if(!result) return;
    try {res.status(200).json(view(result));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  private query(query:Data,operational:boolean):Data|undefined {
    const allowed=operational?['limit','cursor','score','driverId','tripId','from','to']:
      ['limit','cursor','score'];
    if(Object.keys(query).some(key=>!allowed.includes(key))) return;
    const limit=query.limit===undefined?20:Number(query.limit);
    if(!Number.isInteger(limit)||limit<1||limit>100||
       query.cursor!==undefined&&(typeof query.cursor!=='string'||
         !query.cursor||query.cursor.length>2048)) return;
    const result:Data={limit,...(query.cursor?{cursor:query.cursor}:{})};
    if(query.score!==undefined) {const score=Number(query.score);
      if(typeof query.score!=='string'||!/^\d+$/.test(query.score)||
          !Number.isInteger(score)||score<1||score>5) return;
      result.score=score;}
    if(operational) {
      if(query.driverId!==undefined) {if(typeof query.driverId!=='string'||!uuid.test(query.driverId)) return;
        result.driver_id=query.driverId;}
      if(query.tripId!==undefined) {if(typeof query.tripId!=='string'||!uuid.test(query.tripId)) return;
        result.trip_id=query.tripId;}
      if(query.from!==undefined) {if(typeof query.from!=='string') return;
        const value=timestamp(query.from);if(!value) return;result.from=value;}
      if(query.to!==undefined) {if(typeof query.to!=='string') return;
        const value=timestamp(query.to);if(!value) return;result.to=value;}
      if(result.from&&result.to&&Date.parse(String(query.from))>=Date.parse(String(query.to))) return;
    }
    return result;
  }
  @Get('drivers/me/ratings')
  async driver(@Query() query:Data,@Req() req:Request,@Res() res:Response) {
    const input=this.query(query,false);if(!input) return this.invalid(res);
    const result=await this.call('ListMyDriverRatings',input,req,res);
    if(!result) return;
    try {res.status(200).json(page(result));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('operations/ratings')
  async operations(@Query() query:Data,@Req() req:Request,@Res() res:Response) {
    const input=this.query(query,true);if(!input) return this.invalid(res);
    const result=await this.call('ListOperationalRatings',input,req,res);
    if(!result) return;
    try {res.status(200).json(page(result));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
}
