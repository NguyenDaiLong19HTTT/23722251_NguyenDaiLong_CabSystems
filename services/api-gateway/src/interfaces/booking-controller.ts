import {randomUUID} from 'node:crypto';
import {Controller,Get,Param,Post,Query,Req,Res} from '@nestjs/common';
import type {Request,Response} from 'express';
import * as grpc from '@grpc/grpc-js';
import {decodeFacadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {GatewayGrpcClients} from '../infrastructure/grpc-clients.js';
import {BookingCreateLimiter} from '../infrastructure/booking-create-limiter.js';

type Data=Record<string,unknown>;
const record=(value:unknown):value is Data=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const definition=serviceDefinition('cab.gateway.v1.BookingFacadeService',
  'proto/cab/gateway/v1/booking_facade.proto');
const errors:Record<string,{http:number;code:grpc.status}>={
  VALIDATION_ERROR:{http:400,code:grpc.status.INVALID_ARGUMENT},
  INVALID_CURSOR:{http:400,code:grpc.status.INVALID_ARGUMENT},
  CURSOR_EXPIRED:{http:400,code:grpc.status.INVALID_ARGUMENT},
  INVALID_ROUTE:{http:400,code:grpc.status.FAILED_PRECONDITION},
  UNAUTHENTICATED:{http:401,code:grpc.status.UNAUTHENTICATED},
  FORBIDDEN:{http:403,code:grpc.status.PERMISSION_DENIED},
  BOOKING_NOT_FOUND:{http:404,code:grpc.status.NOT_FOUND},
  TRIP_REQUEST_NOT_FOUND:{http:404,code:grpc.status.NOT_FOUND},
  OPERATION_NOT_FOUND:{http:404,code:grpc.status.NOT_FOUND},
  DISPATCH_NOT_FOUND:{http:404,code:grpc.status.NOT_FOUND},
  ACTIVE_BOOKING_OR_TRIP_EXISTS:{http:409,code:grpc.status.ALREADY_EXISTS},
  BOOKING_ALREADY_ASSIGNED:{http:409,code:grpc.status.FAILED_PRECONDITION},
  BOOKING_NOT_CANCELLABLE:{http:409,code:grpc.status.FAILED_PRECONDITION},
  TRIP_REQUEST_NOT_PENDING:{http:409,code:grpc.status.FAILED_PRECONDITION},
  DISPATCH_NOT_ACTIVE:{http:409,code:grpc.status.FAILED_PRECONDITION},
  BOOKING_ALREADY_ASSIGNED_CONFLICT:{http:409,code:grpc.status.ALREADY_EXISTS},
  DRIVER_NOT_AVAILABLE:{http:409,code:grpc.status.FAILED_PRECONDITION},
};
function iso(value:unknown):string {
  if(!record(value)||typeof value.seconds!=='string'||!/^\d+$/.test(value.seconds)||
      typeof value.nanos!=='number'||!Number.isInteger(value.nanos)||
      value.nanos<0||value.nanos>=1e9) throw new Error('Invalid Booking timestamp');
  const date=new Date(Number(value.seconds)*1000+Math.floor(value.nanos/1e6));
  if(!Number.isFinite(date.getTime())) throw new Error('Invalid Booking timestamp');
  return date.toISOString();
}
function safeInteger(value:unknown):number {const result=Number(value);
  if(!Number.isSafeInteger(result)||result<0) throw new Error('Invalid Booking integer');
  return result;}
function location(value:unknown):Data {
  if(!record(value)||!record(value.point)||typeof value.address!=='string'||
      !value.address.trim()||typeof value.point.latitude!=='number'||
      !Number.isFinite(value.point.latitude)||Math.abs(value.point.latitude)>90||
      typeof value.point.longitude!=='number'||!Number.isFinite(value.point.longitude)||
      Math.abs(value.point.longitude)>180) throw new Error('Invalid Booking location');
  return {address:value.address,latitude:value.point.latitude,
    longitude:value.point.longitude};
}
function pricing(value:unknown):Data {
  if(!record(value)||value.vehicle_type!=='MOTORBIKE'||value.currency!=='VND'||
      ![value.base_fare,value.price_per_km,value.price_per_minute].every(record)||
      typeof value.route_id!=='string'||!uuid.test(value.route_id))
    throw new Error('Invalid Booking pricing');
  const decimal=(part:unknown)=>{if(!record(part)||typeof part.value!=='string'||
      !/^(0|[1-9]\d*)(\.\d+)?$/.test(part.value))
      throw new Error('Invalid Booking decimal');return Number(part.value);};
  return {currency:'VND',baseFare:decimal(value.base_fare),
    pricePerKm:decimal(value.price_per_km),pricePerMinute:decimal(value.price_per_minute),
    routeId:value.route_id,routeVersion:safeInteger(value.route_version),
    distanceMeters:safeInteger(value.distance_meters),
    totalAmount:safeInteger(value.total_amount)};
}
function booking(value:unknown):Data {
  if(!record(value)||!uuid.test(String(value.booking_id))||
      !uuid.test(String(value.customer_id))||value.vehicle_type!=='MOTORBIKE'||
      !['PENDING','FINDING_DRIVER','DRIVER_ASSIGNED','NO_DRIVER_FOUND','CANCELLED']
        .includes(String(value.booking_status))||
      typeof value.pricing_version_id!=='string'||!value.pricing_version_id)
    throw new Error('Invalid Booking response');
  const assigned=value.booking_status==='DRIVER_ASSIGNED';
  if(assigned!==Boolean(value.driver_id&&value.trip_id)||
      !assigned&&(value.driver_id||value.trip_id)||
      (value.booking_status==='CANCELLED')!==Boolean(value.cancellation))
    throw new Error('Invalid Booking assignment');
  const result:Data={bookingId:value.booking_id,customerId:value.customer_id,
    pickup:location(value.pickup),destination:location(value.destination),
    vehicleType:'MOTORBIKE',bookingStatus:value.booking_status,
    pricingVersionId:value.pricing_version_id,pricingSnapshot:pricing(value.pricing_snapshot),
    createdAt:iso(value.created_at),updatedAt:iso(value.updated_at)};
  if(value.note!==undefined) result.note=value.note;
  if(assigned) {result.driverId=value.driver_id;result.tripId=value.trip_id;}
  if(record(value.cancellation)) result.cancellation={reason:value.cancellation.reason,
    cancelledBy:value.cancellation.cancelled_by,
    cancelledAt:iso(value.cancellation.cancelled_at)};
  return result;
}
function operation(value:unknown):Data {
  if(!record(value)||!uuid.test(String(value.operation_id))||
      !['CREATE_BOOKING','CANCEL_BOOKING'].includes(String(value.operation_type))||
      !['PROCESSING','SUCCEEDED','FAILED'].includes(String(value.status)))
    throw new Error('Invalid Booking operation');
  const result:Data={operationId:value.operation_id,operationType:value.operation_type,
    status:value.status,createdAt:iso(value.created_at),updatedAt:iso(value.updated_at)};
  if(value.status==='SUCCEEDED') result.result=booking(value.result);
  if(value.status==='FAILED') {
    result.error={errorCode:value.error_code,message:'Request could not be completed'};
    result.failureHttpStatus=safeInteger(value.failure_http_status);
  }
  return result;
}
function offer(value:unknown):Data {
  if(!record(value)||![value.trip_request_id,value.booking_id,value.driver_id]
      .every(part=>typeof part==='string'&&uuid.test(part))||
      !['PENDING','ACCEPTED','REJECTED','EXPIRED','CANCELLED'].includes(String(value.status)))
    throw new Error('Invalid TripRequest');
  const result:Data={tripRequestId:value.trip_request_id,bookingId:value.booking_id,
    driverId:value.driver_id,pickup:location(value.pickup),destination:location(value.destination),
    vehicleType:value.vehicle_type,status:value.status,sentAt:iso(value.sent_at),
    expiresAt:iso(value.expires_at)};
  if(value.note!==undefined) result.note=value.note;
  if(value.resolved_at) result.resolvedAt=iso(value.resolved_at);
  if(value.status==='ACCEPTED') {if(!uuid.test(String(value.trip_id)))
    throw new Error('Invalid accepted TripRequest');result.tripId=value.trip_id;}
  if(value.reject_reason) result.rejectReason=value.reject_reason;
  if(value.closure_reason) result.closureReason=value.closure_reason;
  return result;
}
function requestLocation(value:unknown):Data|undefined {
  if(!record(value)||Object.keys(value).sort().join(',')!=='address,latitude,longitude'||
      typeof value.address!=='string'||!value.address.trim()||
      typeof value.latitude!=='number'||!Number.isFinite(value.latitude)||
      Math.abs(value.latitude)>90||typeof value.longitude!=='number'||
      !Number.isFinite(value.longitude)||Math.abs(value.longitude)>180) return;
  return {point:{latitude:value.latitude,longitude:value.longitude},address:value.address};
}

@Controller('v1')
export class BookingController {
  constructor(private readonly clients:GatewayGrpcClients,
    private readonly createLimiter:BookingCreateLimiter) {}
  private invalid(res:Response):void {res.setHeader('Cache-Control','no-store');
    res.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});}
  private async call(method:string,body:Data,req:Request,res:Response):Promise<Data|undefined> {
    res.setHeader('Cache-Control','no-store');
    const token=req.header('Authorization');
    if(!token||!/^Bearer [^\s]+$/.test(token)) {
      res.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return;}
    try {const target=process.env.BOOKING_SERVICE_GRPC_TARGET;
      if(!target) throw new Error('Booking target unavailable');
      const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
      metadata.set('x-cab-user-authorization',token);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),'booking-service');
      return await unaryCall<Data,Data>(client,definition,method,body,metadata,4000);
    } catch(error) {
      const detail=decodeFacadeError(error as grpc.ServiceError),mapped=detail?errors[detail.reason]:undefined;
      const valid=mapped&&mapped.code===detail?.code&&
        (detail?.reason!=='UNAUTHENTICATED'||detail.origin==='END_USER');
      res.status(valid?mapped.http:503).json({errorCode:valid?detail.reason:'SERVICE_UNAVAILABLE',
        message:valid?'Request could not be completed':'Service temporarily unavailable'});
      return;
    }
  }
  private send(value:Data|undefined,res:Response,shape:(value:Data)=>Data):void {
    if(!value) return;try {res.status(200).json(shape(value));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',
      message:'Service temporarily unavailable'});}
  }
  private mutation(value:Data|undefined,res:Response,success:number):void {
    if(!value) return;
    try {
      const detail=operation(value.operation);
      if(value.status==='PROCESSING') {
        res.setHeader('Location',`/v1/booking-operations/${detail.operationId}`);
        res.setHeader('Retry-After','2');res.status(202).json(detail);return;}
      if(value.status==='FAILED') {const code=String((detail.error as Data).errorCode);
        const status=safeInteger((value.operation as Data).failure_http_status);
      res.status(status).json({errorCode:code,message:'Request could not be completed'});return;}
      const created=booking(value.booking);
      if(success===201) res.setHeader('Location',`/v1/bookings/${created.bookingId}`);
      if(success===201) {
        if(!['QUEUED','SEARCHING','DRIVER_FOUND','NO_DRIVER_AVAILABLE','CANCELLED']
          .includes(String(value.dispatch_status))) throw new Error('Invalid dispatch progress');
        const result:Data={...created,dispatchStatus:value.dispatch_status};
        if(value.initial_offer!==undefined) {
          const first=offer(value.initial_offer);
          if(first.bookingId!==created.bookingId||first.status!=='PENDING'||
              value.dispatch_status!=='SEARCHING') throw new Error('Invalid initial offer');
          result.initialOffer={tripRequestId:first.tripRequestId,driverId:first.driverId,
            status:'PENDING',sentAt:first.sentAt,expiresAt:first.expiresAt};
        }
        res.status(201).json(result);return;
      }
      res.status(success).json(created);
    } catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',
      message:'Service temporarily unavailable'});}
  }
  @Post('bookings') async create(@Req() req:Request,@Res() res:Response) {
    const retry=this.createLimiter.take(req.ip??'unknown');
    if(retry!==undefined) {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Retry-After',String(retry));
      res.status(429).json({errorCode:'RATE_LIMIT_EXCEEDED',message:'Too many requests'});
      return;
    }
    const body=req.body;
    if(!record(body)||Object.keys(body).some(key=>
        !['pickup','destination','vehicleType','note'].includes(key))||
        body.vehicleType!=='MOTORBIKE'||body.note!==undefined&&
          (typeof body.note!=='string'||body.note.length>500)||
        !requestLocation(body.pickup)||!requestLocation(body.destination)) return this.invalid(res);
    this.mutation(await this.call('CreateBooking',{pickup:requestLocation(body.pickup),
      destination:requestLocation(body.destination),vehicle_type:'MOTORBIKE',
      ...(body.note!==undefined?{note:body.note}:{})},req,res),res,201);
  }
  @Get('bookings') async list(@Query() query:Data,@Req() req:Request,@Res() res:Response) {
    if(Object.keys(query).some(key=>!['bookingStatus','limit','cursor'].includes(key))||
        query.bookingStatus!==undefined&&!['PENDING','FINDING_DRIVER','DRIVER_ASSIGNED',
          'NO_DRIVER_FOUND','CANCELLED'].includes(String(query.bookingStatus))) return this.invalid(res);
    const limit=query.limit===undefined?20:Number(query.limit);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||
        query.cursor!==undefined&&(typeof query.cursor!=='string'||query.cursor.length>1024))
      return this.invalid(res);
    const value=await this.call('ListMyBookings',{limit,
      ...(query.bookingStatus?{booking_status:query.bookingStatus}:{}),
      ...(query.cursor?{cursor:query.cursor}:{})},req,res);
    this.send(value,res,raw=>{
      const rows=raw.items??[];
      if(!Array.isArray(rows)) throw new Error('Invalid Booking page');
      const items=rows.map(item=>{if(!record(item)) throw new Error('Invalid Booking summary');
        return {bookingId:item.booking_id,pickup:location(item.pickup),
          destination:location(item.destination),vehicleType:item.vehicle_type,
          bookingStatus:item.booking_status,createdAt:iso(item.created_at),
          updatedAt:iso(item.updated_at),...(item.driver_id?{driverId:item.driver_id}:{}),
          ...(item.trip_id?{tripId:item.trip_id}:{})};});
      return {items,limit:safeInteger(raw.limit),hasMore:raw.has_more,
        ...(raw.next_cursor?{nextCursor:raw.next_cursor}:{})};
    });
  }
  @Get('bookings/:bookingId') async get(@Param('bookingId') bookingId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(bookingId)) return this.invalid(res);
    this.send(await this.call('GetBooking',{booking_id:bookingId},req,res),res,booking);
  }
  @Get('bookings/:bookingId/status') async status(@Param('bookingId') bookingId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(bookingId)) return this.invalid(res);
    this.send(await this.call('GetBookingStatus',{booking_id:bookingId},req,res),res,value=>({
      bookingId:value.booking_id,bookingStatus:value.booking_status,
      ...(value.trip_id?{tripId:value.trip_id}:{}),updatedAt:iso(value.updated_at)}));
  }
  @Post('bookings/:bookingId/cancel') async cancel(@Param('bookingId') bookingId:string,
    @Req() req:Request,@Res() res:Response) {
    const body=req.body;
    if(!uuid.test(bookingId)||!record(body)||Object.keys(body).join(',')!=='reason'||
        typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500)
      return this.invalid(res);
    this.mutation(await this.call('CancelBooking',{booking_id:bookingId,
      reason:body.reason},req,res),res,200);
  }
  @Get('booking-operations/:operationId') async operation(@Param('operationId') operationId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(operationId)) return this.invalid(res);
    this.send(await this.call('GetBookingOperation',{operation_id:operationId},req,res),res,operation);
  }
  @Get('bookings/:bookingId/dispatch/status') async dispatch(@Param('bookingId') bookingId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(bookingId)) return this.invalid(res);
    this.send(await this.call('GetDispatchStatus',{booking_id:bookingId},req,res),res,value=>({
      bookingId:value.booking_id,dispatchStatus:value.dispatch_status,
      attemptCount:safeInteger(value.attempt_count),startedAt:iso(value.started_at),
      deadlineAt:iso(value.deadline_at),configSnapshot:value.config_snapshot,
      updatedAt:iso(value.updated_at),...(value.ended_at?{endedAt:iso(value.ended_at)}:{}),
      ...(value.failure_reason?{failureReason:value.failure_reason}:{}),
      ...(value.driver_id?{driverId:value.driver_id}:{}),
      ...(value.trip_id?{tripId:value.trip_id}:{})}));
  }
  @Get('drivers/me/trip-requests') async offers(@Query() query:Data,
    @Req() req:Request,@Res() res:Response) {
    if(Object.keys(query).some(key=>!['limit','cursor'].includes(key))) return this.invalid(res);
    const limit=query.limit===undefined?20:Number(query.limit);
    if(!Number.isInteger(limit)||limit<1||limit>100) return this.invalid(res);
    this.send(await this.call('ListMyPendingTripRequests',{limit,
      ...(query.cursor?{cursor:query.cursor}:{})},req,res),res,value=>{
      const items=value.items??[];
      if(!Array.isArray(items)) throw new Error('Invalid TripRequest page');
      return {items:items.map(offer),nextCursor:value.next_cursor??null};});
  }
  @Get('trip-requests/:tripRequestId') async getOffer(@Param('tripRequestId') offerId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(offerId)) return this.invalid(res);
    this.send(await this.call('GetMyTripRequest',{trip_request_id:offerId},req,res),res,offer);
  }
  @Post('trip-requests/:tripRequestId/accept') async accept(@Param('tripRequestId') offerId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(offerId)||req.body&&Object.keys(req.body).length>0) return this.invalid(res);
    const value=await this.call('AcceptTripRequest',{trip_request_id:offerId},req,res);
    if(!value) return;
    try {if(value.status==='PROCESSING') {const operationId=String(value.operation_id);
        if(!uuid.test(operationId)) throw new Error('Invalid assignment operation');
        res.setHeader('Location',`/v1/dispatch-operations/${operationId}`);
        res.setHeader('Retry-After','2');res.status(202).json({operationId,
          tripRequestId:offerId,status:'PROCESSING'});return;}
      if(value.status!=='SUCCEEDED') throw new Error('Invalid assignment result');
      res.status(200).json(offer(value.offer));
    } catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',
      message:'Service temporarily unavailable'});}
  }
  @Post('trip-requests/:tripRequestId/reject') async reject(@Param('tripRequestId') offerId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(offerId)||req.body!==undefined&&
        (!record(req.body)||Object.keys(req.body).some(key=>key!=='reason')||
        req.body.reason!==undefined&&
          (typeof req.body.reason!=='string'||!req.body.reason.trim()))) return this.invalid(res);
    this.send(await this.call('RejectTripRequest',{trip_request_id:offerId,
      ...(req.body?.reason?{reason:req.body.reason}:{})},req,res),res,offer);
  }
  @Get('dispatch-operations/:operationId') async assignmentOperation(
    @Param('operationId') operationId:string,@Req() req:Request,@Res() res:Response) {
    if(!uuid.test(operationId)) return this.invalid(res);
    this.send(await this.call('GetMyAssignmentOperation',{operation_id:operationId},req,res),
      res,value=>({operationId:value.operation_id,tripRequestId:value.trip_request_id,
        status:value.status,createdAt:iso(value.created_at),updatedAt:iso(value.updated_at),
        ...(value.status==='SUCCEEDED'?{result:offer(value.result)}:{}),
        ...(value.status==='FAILED'?{error:{errorCode:'DRIVER_NOT_AVAILABLE',
          message:'Request could not be completed'},failureHttpStatus:409}:{})}));
  }
}
