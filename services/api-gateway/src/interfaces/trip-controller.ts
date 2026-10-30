import {randomUUID} from 'node:crypto';
import {Controller,Get,Param,Patch,Post,Query,Req,Res} from '@nestjs/common';
import type {Request,Response} from 'express';
import * as grpc from '@grpc/grpc-js';
import {decodeFacadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {GatewayGrpcClients} from '../infrastructure/grpc-clients.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const def=serviceDefinition('cab.gateway.v1.TripFacadeService','proto/cab/gateway/v1/trip_facade.proto');
const errors:Record<string,{http:number;code:grpc.status}>={
  VALIDATION_ERROR:{http:400,code:grpc.status.INVALID_ARGUMENT},
  INVALID_CURSOR:{http:400,code:grpc.status.INVALID_ARGUMENT},
  CURSOR_EXPIRED:{http:400,code:grpc.status.INVALID_ARGUMENT},
  UNAUTHENTICATED:{http:401,code:grpc.status.UNAUTHENTICATED},
  FORBIDDEN:{http:403,code:grpc.status.PERMISSION_DENIED},
  ACCOUNT_NOT_ACTIVE:{http:403,code:grpc.status.PERMISSION_DENIED},
  TRIP_NOT_FOUND:{http:404,code:grpc.status.NOT_FOUND},
  TRIP_NOT_CLOSED:{http:409,code:grpc.status.FAILED_PRECONDITION},
  TRIP_VERSION_CONFLICT:{http:409,code:grpc.status.FAILED_PRECONDITION},
  INVALID_TRIP_TRANSITION:{http:409,code:grpc.status.FAILED_PRECONDITION},
  TRIP_NOT_CANCELLABLE:{http:409,code:grpc.status.FAILED_PRECONDITION},
  NO_SHOW_WAIT_NOT_REACHED:{http:409,code:grpc.status.FAILED_PRECONDITION},
  IDEMPOTENCY_CONFLICT:{http:409,code:grpc.status.ALREADY_EXISTS},
  PAYMENT_NOT_READY:{http:409,code:grpc.status.FAILED_PRECONDITION},
  TRIP_CLOSED:{http:409,code:grpc.status.FAILED_PRECONDITION},
  TRIP_NOT_RESOLVABLE:{http:409,code:grpc.status.FAILED_PRECONDITION},
};
function iso(v:unknown):string {
  if(!record(v)||typeof v.seconds!=='string'||!/^\d+$/.test(v.seconds)||
      typeof v.nanos!=='number'||!Number.isInteger(v.nanos)||v.nanos<0||v.nanos>=1e9)
    throw new Error('Invalid Trip timestamp');
  const date=new Date(Number(v.seconds)*1000+Math.floor(v.nanos/1e6));
  if(!Number.isFinite(date.getTime())) throw new Error('Invalid Trip timestamp');
  return date.toISOString();
}
function integer(v:unknown):number {const n=Number(v);
  if(!Number.isSafeInteger(n)||n<1) throw new Error('Invalid Trip version');return n;}
function location(v:unknown):Data {
  if(!record(v)||!record(v.point)||typeof v.address!=='string'||!v.address||
      typeof v.point.latitude!=='number'||typeof v.point.longitude!=='number'||
      !Number.isFinite(v.point.latitude)||!Number.isFinite(v.point.longitude)||
      v.point.latitude < -90||v.point.latitude >90||v.point.longitude < -180||v.point.longitude >180)
    throw new Error('Invalid Trip location');
  return {address:v.address,latitude:v.point.latitude,longitude:v.point.longitude};
}
function cancellation(v:unknown):Data {if(!record(v)||
    !['CHANGE_OF_PLANS','VEHICLE_ISSUE','NO_SHOW','OTHER'].includes(String(v.reason_code))||
    typeof v.reason!=='string'||!v.reason.trim()||
    typeof v.cancelled_by!=='string'||!uuid.test(v.cancelled_by))
    throw new Error('Invalid Trip cancellation');
  return {reasonCode:v.reason_code,reason:v.reason,cancelledBy:v.cancelled_by,
    cancelledAt:iso(v.cancelled_at)};}
function view(v:unknown):Data {
  if(!record(v)||![v.trip_id,v.booking_id,v.customer_id,v.driver_id,v.vehicle_id]
      .every(value=>typeof value==='string'&&uuid.test(value))||
      !['STANDARD','PREMIUM','MOTORBIKE','VAN'].includes(String(v.vehicle_type))||
      !['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS','COMPLETED','CANCELLED','ERROR']
        .includes(String(v.trip_status))||!Array.isArray(v.status_history))
    throw new Error('Invalid Trip response');
  const history=v.status_history.map(item=>{if(!record(item)||!['USER','SYSTEM'].includes(String(item.actor_type)))
    throw new Error('Invalid Trip history');
    return {version:integer(item.version),...(item.previous_status?{previousStatus:item.previous_status}:{}),
      newStatus:item.new_status,actorType:item.actor_type,actorId:item.actor_id,
      changedAt:iso(item.changed_at),...(item.reason?{reason:item.reason}:{})};});
  const result:Data={tripId:v.trip_id,bookingId:v.booking_id,customerId:v.customer_id,
    driverId:v.driver_id,vehicleId:v.vehicle_id,vehicleType:v.vehicle_type,
    pickup:location(v.pickup),destination:location(v.destination),tripStatus:v.trip_status,
    version:integer(v.version),createdAt:iso(v.created_at),updatedAt:iso(v.updated_at),
    statusHistory:history};
  for(const [from,to] of [['arrived_at','arrivedAt'],['picked_up_at','pickedUpAt'],
    ['started_at','startedAt'],['completed_at','completedAt'],['closed_at','closedAt']])
    if(v[from]!==undefined) result[to]=iso(v[from]);
  if(v.cancellation!==undefined) result.cancellation=cancellation(v.cancellation);
  if(v.status_before_error!==undefined) {
    if(v.trip_status!=='ERROR'||!['DRIVER_ASSIGNED','ARRIVED_PICKUP',
      'PICKED_UP','IN_PROGRESS'].includes(String(v.status_before_error)))
      throw new Error('Invalid Trip error state');
    result.statusBeforeError=v.status_before_error;
  }
  if(v.trip_status==='ERROR'&&!result.statusBeforeError)
    throw new Error('Incomplete Trip error state');
  if(v.trip_status==='COMPLETED'&&(!result.completedAt||!result.closedAt)||
      v.trip_status==='CANCELLED'&&(!result.cancellation||!result.closedAt))
    throw new Error('Incomplete Trip response');
  return result;
}
function summary(v:unknown):Data {if(!record(v)||typeof v.trip_id!=='string'||!uuid.test(v.trip_id)||
    typeof v.booking_id!=='string'||!uuid.test(v.booking_id)||
    !['STANDARD','PREMIUM','MOTORBIKE','VAN'].includes(String(v.vehicle_type)))
    throw new Error('Invalid Trip summary');
  return {tripId:v.trip_id,bookingId:v.booking_id,pickup:location(v.pickup),
    destination:location(v.destination),vehicleType:v.vehicle_type,tripStatus:v.trip_status,
    createdAt:iso(v.created_at),...(v.closed_at?{closedAt:iso(v.closed_at)}:{})};}

@Controller('v1')
export class TripController {
  constructor(private readonly clients:GatewayGrpcClients) {}
  private invalid(res:Response):void {res.setHeader('Cache-Control','no-store');
    res.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});}
  private async call(method:string,body:Data,req:Request,res:Response):Promise<Data|undefined> {
    res.setHeader('Cache-Control','no-store');
    const token=req.header('Authorization');
    if(!token||!/^Bearer [^\s]+$/.test(token)) {
      res.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return;}
    try {
      const target=process.env.TRIP_SERVICE_GRPC_TARGET;
      if(!target) throw new Error('Trip target unavailable');
      const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
      metadata.set('x-cab-user-authorization',token);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),'trip-service');
      return await unaryCall<Data,Data>(client,def,method,body,metadata,4000);
    } catch(error) {
      const detail=decodeFacadeError(error as grpc.ServiceError),mapped=detail?errors[detail.reason]:undefined;
      const valid=mapped&&mapped.code===detail?.code&&
        (detail?.reason!=='UNAUTHENTICATED'||detail.origin==='END_USER');
      res.status(valid?mapped.http:503).json({errorCode:valid?detail.reason:'SERVICE_UNAVAILABLE',
        message:valid?'Request could not be completed':'Service temporarily unavailable'});
      return;
    }
  }
  private send(v:Data|undefined,res:Response,shape:(value:Data)=>Data=view):void {
    if(!v) return;try {res.status(200).json(shape(v));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('trips/:tripId') async get(@Param('tripId') tripId:string,@Req() req:Request,@Res() res:Response) {
    if(!uuid.test(tripId)) return this.invalid(res);
    this.send(await this.call('GetTrip',{trip_id:tripId},req,res),res);
  }
  @Get('trips/:tripId/tracking') async tracking(@Param('tripId') tripId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(tripId)) return this.invalid(res);
    this.send(await this.call('GetTripTracking',{trip_id:tripId},req,res),res,value=>{
      if(!uuid.test(String(value.trip_id))||
          !['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS',
            'COMPLETED','CANCELLED','ERROR'].includes(String(value.trip_status))||
          !['LIVE','STALE','UNAVAILABLE','STOPPED'].includes(String(value.tracking_status))||
          !['AVAILABLE','UNAVAILABLE','NOT_APPLICABLE'].includes(String(value.eta_status))||
          !record(value.driver)||!record(value.vehicle)||
          !uuid.test(String(value.driver.driver_id))||!uuid.test(String(value.vehicle.vehicle_id))||
          typeof value.driver.full_name!=='string'||!value.driver.full_name.trim()||
          typeof value.vehicle.license_plate!=='string'||!value.vehicle.license_plate.trim()||
          !['STANDARD','PREMIUM','MOTORBIKE','VAN'].includes(String(value.vehicle.vehicle_type)))
        throw new Error('Invalid tracking response');
      const stopped=value.tracking_status==='STOPPED';
      if(stopped!==Boolean(value.closed_at)||
          stopped&&value.driver.phone!==undefined||
          stopped&&value.driver_location!==undefined||
          value.eta_status==='AVAILABLE'&&value.estimated_arrival_seconds===undefined||
          value.eta_status!=='AVAILABLE'&&value.estimated_arrival_seconds!==undefined||
          value.tracking_status==='LIVE'&&value.driver_location===undefined||
          value.tracking_status==='STALE'&&value.driver_location===undefined||
          value.tracking_status==='UNAVAILABLE'&&value.driver_location!==undefined)
        throw new Error('Inconsistent tracking response');
      const point=value.driver_location;
      const driverLocation=record(point)?{latitude:point.latitude,longitude:point.longitude,
        recordedAt:iso(point.recorded_at),receivedAt:iso(point.received_at)}:null;
      if(driverLocation&&(typeof driverLocation.latitude!=='number'||
          typeof driverLocation.longitude!=='number'||
          !Number.isFinite(driverLocation.latitude)||!Number.isFinite(driverLocation.longitude)||
          Math.abs(driverLocation.latitude)>90||Math.abs(driverLocation.longitude)>180))
        throw new Error('Invalid tracking location');
      return {tripId:value.trip_id,tripStatus:value.trip_status,
        tripVersion:integer(value.trip_version),driver:{driverId:value.driver.driver_id,
          fullName:value.driver.full_name,
          ...(typeof value.driver.phone==='string'?{phone:value.driver.phone}:{})},
        vehicle:{vehicleId:value.vehicle.vehicle_id,licensePlate:value.vehicle.license_plate,
          vehicleType:value.vehicle.vehicle_type},trackingStatus:value.tracking_status,
        driverLocation,etaStatus:value.eta_status,
        estimatedArrivalSeconds:value.estimated_arrival_seconds===undefined?null:
          Number(value.estimated_arrival_seconds),
        ...(stopped?{closedAt:iso(value.closed_at)}:{}),snapshotAt:iso(value.snapshot_at)};
    });
  }
  @Get('trips') async list(@Query() query:Data,@Req() req:Request,@Res() res:Response) {
    if(Object.keys(query).some(key=>!['tripStatus','from','to','limit','cursor'].includes(key))||
        query.tripStatus!==undefined&&!['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS',
          'COMPLETED','CANCELLED','ERROR'].includes(String(query.tripStatus))) return this.invalid(res);
    const limit=query.limit===undefined?20:Number(query.limit);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100) return this.invalid(res);
    const time=(value:unknown)=>{if(value===undefined) return;
      if(typeof value!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(value)||
          !Number.isFinite(Date.parse(value))) throw new Error('Invalid date');
      const date=new Date(value);return {seconds:String(Math.floor(date.getTime()/1000)),
        nanos:(date.getTime()%1000)*1e6};};
    let from:Data|undefined,to:Data|undefined;
    try {from=time(query.from);to=time(query.to);} catch {return this.invalid(res);}
    if(from&&to&&Date.parse(String(query.from))>=Date.parse(String(query.to)))
      return this.invalid(res);
    if(query.cursor!==undefined&&(typeof query.cursor!=='string'||query.cursor.length>1024))
      return this.invalid(res);
    const value=await this.call('ListMyTrips',{limit,
      ...(query.tripStatus?{trip_status:query.tripStatus}:{}),...(from?{from}:{}),...(to?{to}:{}),
      ...(query.cursor?{cursor:query.cursor}:{})},req,res);
    if(!value) return;
    try {const items=value.items??[];
      if(!Array.isArray(items)) throw new Error('Invalid Trip page');
      res.status(200).json({items:items.map(summary),nextCursor:value.next_cursor??null});}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Patch('trips/:tripId/status') async status(@Param('tripId') tripId:string,@Req() req:Request,
    @Res() res:Response) {
    const body=req.body;
    if(!uuid.test(tripId)||!record(body)||Object.keys(body).sort().join(',')!==
        'expectedVersion,tripStatus'||!Number.isSafeInteger(body.expectedVersion)||
        Number(body.expectedVersion)<1||!['ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS','COMPLETED']
          .includes(String(body.tripStatus))) return this.invalid(res);
    this.send(await this.call('UpdateTripStatus',{trip_id:tripId,
      expected_version:String(body.expectedVersion),trip_status:body.tripStatus,
      command_id:randomUUID()},req,res),res);
  }
  @Post('trips/:tripId/cancel') async cancel(@Param('tripId') tripId:string,@Req() req:Request,
    @Res() res:Response) {
    const body=req.body;
    const keys=record(body)?Object.keys(body).sort().join(','):'';
    const simple=keys==='reason';
    if(!uuid.test(tripId)||!record(body)||
        (!simple&&(keys!=='expectedVersion,reason,reasonCode'||
          !Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||
          !['CHANGE_OF_PLANS','VEHICLE_ISSUE','NO_SHOW','OTHER'].includes(String(body.reasonCode))))||
        typeof body.reason!=='string'||!body.reason.trim()) return this.invalid(res);
    let expectedVersion:string;
    if(simple) {
      const current=await this.call('GetTrip',{trip_id:tripId},req,res);
      if(!current) return;
      try {
        if(current.trip_id!==tripId) throw new Error('Trip identity mismatch');
        expectedVersion=String(integer(current.version));
      } catch {
        res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});
        return;
      }
    } else expectedVersion=String(body.expectedVersion);
    this.send(await this.call('CancelTrip',{trip_id:tripId,
      expected_version:expectedVersion,reason_code:simple?'CHANGE_OF_PLANS':body.reasonCode,
      reason:body.reason,command_id:randomUUID()},req,res),res);
  }
  @Post('trips/:tripId/incidents') async incident(@Param('tripId') tripId:string,
    @Req() req:Request,@Res() res:Response) {
    const body=req.body;
    if(!uuid.test(tripId)||!record(body)||Object.keys(body).sort().join(',')!==
        'description,expectedVersion,issueType'||
        !Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||
        !['VEHICLE_BREAKDOWN','ACCIDENT','PASSENGER_ISSUE','OTHER']
          .includes(String(body.issueType))||typeof body.description!=='string'||
        !body.description.trim()||body.description.length>2000) return this.invalid(res);
    const value=await this.call('ReportTripIncident',{trip_id:tripId,
      expected_version:String(body.expectedVersion),issue_type:body.issueType,
      description:body.description,command_id:randomUUID()},req,res);
    if(!value) return;
    try {
      if(!record(value.incident)||!uuid.test(String(value.incident.incident_id))||
          value.incident.trip_id!==tripId||value.incident.status!=='OPEN'||
          !uuid.test(String(value.incident.reported_by_account_id))||
          typeof value.incident.description!=='string'||
          !['VEHICLE_BREAKDOWN','ACCIDENT','PASSENGER_ISSUE','OTHER']
            .includes(String(value.incident.issue_type)))
        throw new Error('Invalid incident response');
      const trip=view(value.trip);
      if(trip.tripStatus!=='ERROR') throw new Error('Invalid incident Trip');
      res.status(201).json({incident:{incidentId:value.incident.incident_id,
        tripId:value.incident.trip_id,issueType:value.incident.issue_type,
        description:value.incident.description,status:'OPEN',
        reportedByAccountId:value.incident.reported_by_account_id,
        createdAt:iso(value.incident.created_at)},trip});
    } catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',
      message:'Service temporarily unavailable'});}
  }
  @Get('trips/:tripId/closure') async closure(@Param('tripId') tripId:string,
    @Req() req:Request,@Res() res:Response) {
    if(!uuid.test(tripId)) return this.invalid(res);
    this.send(await this.call('GetTripClosure',{trip_id:tripId},req,res),res,value=>{
      if(!uuid.test(String(value.operation_id))||!uuid.test(String(value.trip_id))||
          !['PENDING','CONFIRMED'].includes(String(value.driver_release))||
          !['PENDING','CONFIRMED'].includes(String(value.customer_release)))
        throw new Error('Invalid Trip closure');
      return {operationId:value.operation_id,tripId:value.trip_id,status:value.status,
        driverRelease:value.driver_release,customerRelease:value.customer_release,
        createdAt:iso(value.created_at),updatedAt:iso(value.updated_at)};});
  }
  @Post('operations/trips/:tripId/resolve-error')
  async resolveError(@Param('tripId') tripId:string,@Req() req:Request,@Res() res:Response) {
    const body=req.body;
    if(!uuid.test(tripId)||!record(body)||Object.keys(body).sort().join(',')!==
        'expectedTripVersion,resolutionAction,resolutionNote'||
        !Number.isSafeInteger(body.expectedTripVersion)||Number(body.expectedTripVersion)<1||
        !['RESTORE_PREVIOUS_STATUS','CLOSE_ABNORMALLY'].includes(String(body.resolutionAction))||
        typeof body.resolutionNote!=='string'||!body.resolutionNote.trim()||
        body.resolutionNote.length>2000) return this.invalid(res);
    const value=await this.call('ResolveTripError',{trip_id:tripId,
      expected_trip_version:String(body.expectedTripVersion),
      resolution_action:body.resolutionAction,resolution_note:body.resolutionNote.trim()},req,res);
    if(!value) return;
    try {
      if(!record(value.trip)||value.trip.trip_id!==tripId||
          !Array.isArray(value.resolved_incident_ids)||!value.resolved_incident_ids.length||
          !value.resolved_incident_ids.every(item=>typeof item==='string'&&uuid.test(item))||
          value.resolution_action!==body.resolutionAction||
          !uuid.test(String(value.resolved_by_account_id))) throw new Error('Invalid resolution');
      const trip=value.trip;
      if(body.resolutionAction==='CLOSE_ABNORMALLY'&&
          (trip.trip_status!=='ERROR'||!trip.closed_at||
            !['DRIVER_ASSIGNED','ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS']
              .includes(String(trip.status_before_error))||
            trip.close_reason!==body.resolutionNote.trim())||
          body.resolutionAction==='RESTORE_PREVIOUS_STATUS'&&
          (trip.trip_status==='ERROR'||trip.closed_at||trip.status_before_error||trip.close_reason))
        throw new Error('Invalid resolved Trip');
      res.status(200).json({trip:{tripId,tripStatus:trip.trip_status,
        version:integer(trip.version),updatedAt:iso(trip.updated_at),
        ...(trip.status_before_error?{statusBeforeError:trip.status_before_error}:{}),
        ...(trip.closed_at?{closedAt:iso(trip.closed_at),closeReason:trip.close_reason}:{})},
        resolvedIncidentIds:value.resolved_incident_ids,resolutionAction:value.resolution_action,
        resolvedAt:iso(value.resolved_at),resolvedByAccountId:value.resolved_by_account_id});
    } catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',
      message:'Service temporarily unavailable'});}
  }
}
