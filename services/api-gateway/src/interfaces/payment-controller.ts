import {randomUUID} from 'node:crypto';
import {Controller,Get,Param,Post,Req,Res} from '@nestjs/common';
import type {Request,Response} from 'express';
import * as grpc from '@grpc/grpc-js';
import {decodeFacadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {GatewayGrpcClients} from '../infrastructure/grpc-clients.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const definition=serviceDefinition('cab.gateway.v1.PaymentFacadeService',
  'proto/cab/gateway/v1/payment_facade.proto');
const errors:Record<string,{http:number;grpc:grpc.status}>={
  VALIDATION_ERROR:{http:400,grpc:grpc.status.INVALID_ARGUMENT},
  PAYMENT_AMOUNT_MISMATCH:{http:400,grpc:grpc.status.INVALID_ARGUMENT},
  UNAUTHENTICATED:{http:401,grpc:grpc.status.UNAUTHENTICATED},
  FORBIDDEN:{http:403,grpc:grpc.status.PERMISSION_DENIED},
  TRIP_NOT_FOUND:{http:404,grpc:grpc.status.NOT_FOUND},
  PAYMENT_NOT_FOUND:{http:404,grpc:grpc.status.NOT_FOUND},
  FARE_NOT_READY:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  TRIP_NOT_PAYABLE:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  TRIP_NOT_COMPLETED:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  TRIP_CANCELLED:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  PAYMENT_ALREADY_EXISTS:{http:409,grpc:grpc.status.ALREADY_EXISTS},
  PAYMENT_ALREADY_PAID:{http:409,grpc:grpc.status.ALREADY_EXISTS},
  PAYMENT_NOT_PENDING:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  PAYMENT_NOT_CASH:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  PAYMENT_NOT_RETRYABLE:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  PAYMENT_REQUIRES_REVIEW:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  PAYMENT_REQUIRES_RECONCILIATION:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  PAYMENT_VERSION_CONFLICT:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  PAYMENT_ATTEMPT_CONFLICT:{http:409,grpc:grpc.status.FAILED_PRECONDITION},
  IDEMPOTENCY_CONFLICT:{http:409,grpc:grpc.status.ALREADY_EXISTS},
};
const iso=(v:unknown):string=>{
  if (!record(v)||typeof v.seconds!=='string'||!/^\d+$/.test(v.seconds)||
      typeof v.nanos!=='number'||!Number.isInteger(v.nanos)||v.nanos<0||v.nanos>=1e9)
    throw new Error('Invalid Payment timestamp');
  return new Date(Number(v.seconds)*1000+Math.floor(v.nanos/1e6)).toISOString();
};
const number=(v:unknown):number=>{
  const value=Number(v);
  if (!Number.isSafeInteger(value)||value<0) throw new Error('Invalid Payment number');
  return value;
};
export function paymentResponse(v:unknown):Data {
  if (!record(v)||![v.payment_id,v.trip_id,v.fare_id,v.customer_id,v.current_attempt_id]
        .every(id=>typeof id==='string'&&uuid.test(id))||
      !['CASH','DEMO_TRANSFER'].includes(String(v.method))||
      !['PAYMENT_PENDING','PAYMENT_PROCESSING','PAYMENT_SUCCESS','PAYMENT_FAILED','PAYMENT_UNKNOWN'].includes(String(v.payment_status))||
      v.currency!=='VND'||typeof v.requires_review!=='boolean')
    throw new Error('Invalid Payment response');
  const amount=number(v.amount),version=number(v.version);
  if (version<1||(v.payment_status==='PAYMENT_SUCCESS')!==Boolean(v.paid_at))
    throw new Error('Invalid Payment status');
  return {paymentId:v.payment_id,tripId:v.trip_id,fareId:v.fare_id,
    customerId:v.customer_id,amount,currency:'VND',method:v.method,
    paymentStatus:String(v.payment_status).slice('PAYMENT_'.length),currentAttemptId:v.current_attempt_id,
    requiresReview:v.requires_review,version,createdAt:iso(v.created_at),
    updatedAt:iso(v.updated_at),...(v.paid_at?{paidAt:iso(v.paid_at)}:{}),
    ...(v.confirmed_by_account_id?{confirmedByAccountId:v.confirmed_by_account_id}:{})};
}
function attemptResponse(v:unknown):Data {
  if (!record(v)||![v.attempt_id,v.payment_id].every(value=>
        typeof value==='string'&&uuid.test(value))||
      !['CASH','DEMO_TRANSFER'].includes(String(v.method))||
      !['PAYMENT_PENDING','PAYMENT_PROCESSING','PAYMENT_SUCCESS','PAYMENT_FAILED',
        'PAYMENT_UNKNOWN'].includes(String(v.status))||v.currency!=='VND')
    throw new Error('Invalid Payment attempt');
  const attemptNumber=number(v.attempt_number);
  if (attemptNumber<1||Boolean(v.resolved_at)!==
      ['PAYMENT_SUCCESS','PAYMENT_FAILED'].includes(String(v.status)))
    throw new Error('Invalid Payment attempt state');
  const result:Data={attemptId:v.attempt_id,paymentId:v.payment_id,
    attemptNumber,method:v.method,amount:number(v.amount),currency:'VND',
    status:String(v.status).slice('PAYMENT_'.length),
    createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)};
  if (v.merchant_reference!==undefined) {
    if (typeof v.merchant_reference!=='string'||!uuid.test(v.merchant_reference))
      throw new Error('Invalid merchant reference');
    result.merchantReference=v.merchant_reference;
  }
  if (v.resolved_at!==undefined) result.resolvedAt=iso(v.resolved_at);
  if (v.confirmed_by_account_id!==undefined) {
    if (typeof v.confirmed_by_account_id!=='string'||!uuid.test(v.confirmed_by_account_id))
      throw new Error('Invalid cash confirmer');
    result.confirmedByAccountId=v.confirmed_by_account_id;
  }
  return result;
}

@Controller('v1')
export class PaymentController {
  constructor(private readonly clients:GatewayGrpcClients) {}
  private auth(request:Request,response:Response,keyRequired:boolean):string|undefined {
    const token=request.header('Authorization');
    if (!token||!/^Bearer [^\s]+$/.test(token)) {
      response.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return;
    }
    const key=request.header('Idempotency-Key');
    if (keyRequired&&(!key||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid Idempotency-Key'});return;
    }
    return token;
  }
  private async call(method:string,body:Data,request:Request,response:Response,
    keyRequired=false):Promise<Data|undefined> {
    response.setHeader('Cache-Control','no-store');
    const token=this.auth(request,response,keyRequired);if (!token) return;
    try {
      const target=process.env.PAYMENT_SERVICE_GRPC_TARGET;
      if (!target) throw new Error('Payment target missing');
      const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
      metadata.set('x-cab-user-authorization',token);
      if (keyRequired) metadata.set('x-cab-idempotency-key',request.header('Idempotency-Key')!);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),'payment-service');
      return await unaryCall<Data,Data>(client,definition,method,body,metadata,4000);
    } catch(error) {
      const detail=decodeFacadeError(error as grpc.ServiceError);
      const mapped=detail?errors[detail.reason]:undefined;
      const valid=mapped&&mapped.grpc===detail?.code&&
        (detail?.reason!=='UNAUTHENTICATED'||detail.origin==='END_USER');
      response.status(valid?mapped.http:503).json({errorCode:valid?detail.reason:'SERVICE_UNAVAILABLE',
        message:valid?'Request could not be completed':'Service temporarily unavailable'});
      return;
    }
  }
  private invalid(response:Response):void {
    response.setHeader('Cache-Control','no-store');
    response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});
  }
  private send(value:Data|undefined,response:Response,status:number):void {
    if (!value) return;
    try {response.status(status).json(paymentResponse(value));}
    catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Post('trips/:tripId/payments')
  async create(@Param('tripId') tripId:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    if (!uuid.test(tripId)||!record(req.body)||Object.keys(req.body).join(',')!=='paymentMethod'||
        !['CASH','DEMO_TRANSFER'].includes(String(req.body.paymentMethod))) return this.invalid(res);
    const value=await this.call('CreateTripPayment',{trip_id:tripId,
      payment_method:req.body.paymentMethod},req,res,true);
    if (value&&typeof value.payment_id==='string') res.setHeader('Location',`/v1/payments/${value.payment_id}`);
    this.send(value,res,201);
  }
  @Get('trips/:tripId/payment')
  async byTrip(@Param('tripId') tripId:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    if (!uuid.test(tripId)) return this.invalid(res);
    this.send(await this.call('GetTripPayment',{trip_id:tripId},req,res),res,200);
  }
  @Get('trips/:tripId/fare')
  async fare(@Param('tripId') tripId:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    if (!uuid.test(tripId)) return this.invalid(res);
    const value=await this.call('GetTripFare',{trip_id:tripId},req,res);
    if (!value) return;
    try {
      if (![value.fare_id,value.trip_id,value.pricing_version_id,value.route_id]
          .every(id=>typeof id==='string'&&uuid.test(id))||value.currency!=='VND')
        throw new Error('Invalid Fare response');
      res.status(200).json({fareId:value.fare_id,tripId:value.trip_id,
        pricingVersionId:value.pricing_version_id,routeId:value.route_id,
        routeVersion:number(value.route_version),distanceMeters:number(value.distance_meters),
        totalAmount:number(value.total_amount),currency:'VND',calculatedAt:iso(value.calculated_at)});
    } catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('payments/:paymentId')
  async byId(@Param('paymentId') paymentId:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    if (!uuid.test(paymentId)) return this.invalid(res);
    this.send(await this.call('GetPayment',{payment_id:paymentId},req,res),res,200);
  }
  @Get('payments/:paymentId/attempts')
  async attempts(@Param('paymentId') paymentId:string,@Req() req:Request,
    @Res() res:Response):Promise<void> {
    const keys=Object.keys(req.query);
    const limit=req.query.limit===undefined?20:Number(req.query.limit);
    const cursor=req.query.cursor;
    if (!uuid.test(paymentId)||keys.some(key=>!['limit','cursor'].includes(key))||
        !Number.isSafeInteger(limit)||limit<1||limit>100||
        cursor!==undefined&&(typeof cursor!=='string'||!cursor||cursor.length>512))
      return this.invalid(res);
    const value=await this.call('ListPaymentAttempts',{payment_id:paymentId,
      limit,...(cursor?{cursor}:{})},req,res);
    if (!value) return;
    try {
      const items=value.items??[];
      if (!Array.isArray(items)||items.length>limit||
          value.next_cursor!==undefined&&typeof value.next_cursor!=='string')
        throw new Error('Invalid Payment attempts page');
      res.status(200).json({items:items.map(attemptResponse),
        nextCursor:value.next_cursor??null});
    } catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',
      message:'Service temporarily unavailable'});}
  }
  @Post('payments/:paymentId/confirm-cash')
  async cash(@Param('paymentId') paymentId:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    if (!uuid.test(paymentId)||!record(req.body)||Object.keys(req.body).join(',')!=='expectedVersion'||
        !Number.isSafeInteger(req.body.expectedVersion)||Number(req.body.expectedVersion)<1)
      return this.invalid(res);
    this.send(await this.call('ConfirmCash',{payment_id:paymentId,
      expected_version:String(req.body.expectedVersion)},req,res,true),res,200);
  }
  @Post('payments/:paymentId/retry')
  async retry(@Param('paymentId') paymentId:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    if (!uuid.test(paymentId)||!record(req.body)||
        Object.keys(req.body).sort().join(',')!=='expectedVersion,paymentMethod'||
        !Number.isSafeInteger(req.body.expectedVersion)||Number(req.body.expectedVersion)<1||
        !['CASH','DEMO_TRANSFER'].includes(String(req.body.paymentMethod))) return this.invalid(res);
    this.send(await this.call('RetryPayment',{payment_id:paymentId,
      expected_version:String(req.body.expectedVersion),payment_method:req.body.paymentMethod},
      req,res,true),res,202);
  }
  @Post('payments/:paymentId/demo-result')
  async demo(@Param('paymentId') paymentId:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    if (process.env.NODE_ENV!=='development'||process.env.CAB_DEMO_PAYMENT_RESULT_ENABLED!=='1') {
      res.status(403).json({errorCode:'FORBIDDEN',message:'Demo payment disabled'});return;
    }
    const body=req.body;
    if (!uuid.test(paymentId)||!record(body)||
        Object.keys(body).sort().join(',')!=='attemptId,currency,expectedAmount,expectedVersion,outcome'||
        typeof body.attemptId!=='string'||!uuid.test(body.attemptId)||
        !Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||
        !Number.isSafeInteger(body.expectedAmount)||Number(body.expectedAmount)<0||
        body.currency!=='VND'||!['SUCCESS','FAILED'].includes(String(body.outcome)))
      return this.invalid(res);
    this.send(await this.call('SimulateDemoTransfer',{payment_id:paymentId,
      attempt_id:body.attemptId,
      expected_version:String(body.expectedVersion),expected_amount:String(body.expectedAmount),
      currency:'VND',outcome:body.outcome==='SUCCESS'?'DEMO_SUCCESS':'DEMO_FAILED'},
      req,res,true),res,200);
  }
}
