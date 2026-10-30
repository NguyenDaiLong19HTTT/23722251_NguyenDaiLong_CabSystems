import { randomUUID } from 'node:crypto';
import { Controller,Get,Put,Req,Res } from '@nestjs/common';
import type { Request,Response } from 'express';
import * as grpc from '@grpc/grpc-js';
import { decodeFacadeError,readTlsFromEnvironment,serviceDefinition,unaryCall } from '@cab/grpc-transport';
import { GatewayGrpcClients } from '../infrastructure/grpc-clients.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const definition=serviceDefinition('cab.gateway.v1.DriverFacadeService',
  'proto/cab/gateway/v1/driver_facade.proto');
const errors:Record<string,number>={VALIDATION_ERROR:400,UNAUTHENTICATED:401,FORBIDDEN:403,
  ACCOUNT_NOT_ACTIVE:403,DRIVER_NOT_FOUND:404,VERSION_CONFLICT:409,
  IDEMPOTENCY_CONFLICT:409,DRIVER_NOT_ELIGIBLE:409,LOCATION_STALE:409,
  RESOURCE_RESERVED:409,LOCATION_TIMESTAMP_CONFLICT:409};
errors.INVALID_CURSOR=400;errors.CURSOR_EXPIRED=400;
const driverIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const expected:Record<string,grpc.status>={VALIDATION_ERROR:grpc.status.INVALID_ARGUMENT,
  UNAUTHENTICATED:grpc.status.UNAUTHENTICATED,FORBIDDEN:grpc.status.PERMISSION_DENIED,
  ACCOUNT_NOT_ACTIVE:grpc.status.PERMISSION_DENIED,DRIVER_NOT_FOUND:grpc.status.NOT_FOUND,
  VERSION_CONFLICT:grpc.status.FAILED_PRECONDITION,IDEMPOTENCY_CONFLICT:grpc.status.ALREADY_EXISTS,
  DRIVER_NOT_ELIGIBLE:grpc.status.FAILED_PRECONDITION,LOCATION_STALE:grpc.status.FAILED_PRECONDITION,
  RESOURCE_RESERVED:grpc.status.ALREADY_EXISTS,LOCATION_TIMESTAMP_CONFLICT:grpc.status.ALREADY_EXISTS};
expected.INVALID_CURSOR=grpc.status.INVALID_ARGUMENT;
expected.CURSOR_EXPIRED=grpc.status.INVALID_ARGUMENT;
export function iso(v:unknown):string {
  if (!record(v)||typeof v.seconds!=='string'||!/^\d+$/.test(v.seconds)||
      typeof v.nanos!=='number'||!Number.isInteger(v.nanos)||v.nanos<0||v.nanos>=1e9)
    throw new Error('Invalid timestamp');
  return new Date(Number(v.seconds)*1000+Math.floor(v.nanos/1e6)).toISOString();
}
export function version(v:unknown):number {
  const n=Number(v);
  if (!Number.isSafeInteger(n)||n<1) throw new Error('Invalid version');
  return n;
}
export function driver(v:unknown):Data {
  if (!record(v)||!['PENDING_APPROVAL','APPROVED','REJECTED'].includes(String(v.approval_status))||
      !['AVAILABLE','BUSY','OFFLINE'].includes(String(v.driver_status))||
      ![v.driver_id,v.account_id,v.license_number].every(s=>typeof s==='string'&&s))
    throw new Error('Invalid Driver response');
  if ((v.approval_status==='REJECTED')!==
      (typeof v.rejection_reason==='string'&&v.rejection_reason.length>0))
    throw new Error('Invalid Driver rejection reason');
  return {driverId:v.driver_id,accountId:v.account_id,licenseNumber:v.license_number,
    approvalStatus:v.approval_status,driverStatus:v.driver_status,
    ...(v.approval_status==='REJECTED'?{rejectionReason:v.rejection_reason}:{}),
    vehicleId:typeof v.vehicle_id==='string'&&v.vehicle_id?v.vehicle_id:null,
    version:version(v.version),createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)};
}
export function vehicle(v:unknown):Data {
  if (!record(v)||![v.vehicle_id,v.plate_number,v.assigned_driver_id].every(s=>typeof s==='string'&&s)||
      !['STANDARD','PREMIUM','MOTORBIKE','VAN'].includes(String(v.vehicle_type))||
      !['VEHICLE_ACTIVE','VEHICLE_INACTIVE'].includes(String(v.vehicle_status)))
    throw new Error('Invalid Vehicle response');
  return {vehicleId:v.vehicle_id,plateNumber:v.plate_number,vehicleType:v.vehicle_type,
    vehicleStatus:v.vehicle_status==='VEHICLE_ACTIVE'?'ACTIVE':'INACTIVE',
    assignedDriverId:v.assigned_driver_id,version:version(v.version),
    createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)};
}
function profile(v:unknown):Data {
  if (!record(v)) throw new Error('Invalid Driver profile');
  const d=driver(v.driver);
  if (d.vehicleId===null) return {driver:d};
  const car=vehicle(v.vehicle);
  if (car.vehicleId!==d.vehicleId||car.assignedDriverId!==d.driverId)
    throw new Error('Driver/Vehicle binding mismatch');
  return {driver:d,vehicle:car};
}
function locationResult(v:unknown):Data {
  if (!record(v)||typeof v.location_updated!=='boolean'||!record(v.current_location))
    throw new Error('Invalid location result');
  const loc=v.current_location;
  if (typeof loc.latitude!=='number'||typeof loc.longitude!=='number'||
      !Number.isFinite(loc.latitude)||!Number.isFinite(loc.longitude))
    throw new Error('Invalid location coordinates');
  return {locationUpdated:v.location_updated,currentLocation:{latitude:loc.latitude,
    longitude:loc.longitude,recordedAt:iso(loc.recorded_at),receivedAt:iso(loc.received_at)}};
}
@Controller('v1')
export class DriverController {
  private readonly limits=new Map<string,{count:number;until:number}>();
  constructor(private readonly clients:GatewayGrpcClients) {}
  private limit(request:Request,response:Response,method:string):boolean {
    const key=`${method}:${request.ip}`,now=Date.now(),prior=this.limits.get(key);
    const slot=prior&&prior.until>now?prior:{count:0,until:now+60000};
    slot.count++;this.limits.set(key,slot);
    if (slot.count>30) {response.setHeader('Retry-After',String(Math.ceil((slot.until-now)/1000)));
      response.status(429).json({errorCode:'RATE_LIMIT_EXCEEDED',message:'Too many requests'});return false;}
    return true;
  }
  private async call(method:string,body:Data,request:Request,response:Response,
    internalKey?:string):Promise<Data|undefined> {
    response.setHeader('Cache-Control','no-store');
    try {
      const target=process.env.DRIVER_SERVICE_GRPC_TARGET;
      if (!target) throw new Error('Driver gRPC target missing');
      const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
      metadata.set('x-cab-user-authorization',request.header('Authorization')!);
      if (method==='SetMyDriverAvailability')
        metadata.set('x-cab-idempotency-key',internalKey!);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),'driver-service');
      return await unaryCall<Data,Data>(client,definition,method,body,metadata,3000);
    } catch(error) {
      const failure=decodeFacadeError(error as grpc.ServiceError);
      const reason=failure?.reason;
      const code=reason&&failure?.code===expected[reason]&&
        (failure.code!==grpc.status.UNAUTHENTICATED||failure.origin==='END_USER')?errors[reason]:undefined;
      response.status(code??503).json({errorCode:code?reason:'SERVICE_UNAVAILABLE',
        message:code?'Request could not be completed':'Service temporarily unavailable'});
      return undefined;
    }
  }
  private authorized(request:Request,response:Response):boolean {
    if (!/^Bearer [^\s]+$/.test(request.header('Authorization')??'')) {
      response.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return false;
    }
    return true;
  }
  @Get('drivers/nearby')
  async nearby(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'driver-nearby')||!this.authorized(request,response)) return;
    const query=request.query;
    if (Object.keys(query).some(key=>!['latitude','longitude','radiusKm','limit','cursor'].includes(key))||
        typeof query.latitude!=='string'||typeof query.longitude!=='string'||
        (query.radiusKm!==undefined&&typeof query.radiusKm!=='string')||
        (query.limit!==undefined&&typeof query.limit!=='string')||
        (query.cursor!==undefined&&(typeof query.cursor!=='string'||!query.cursor))) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    const number=(value:string)=>value.trim()!==''&&Number.isFinite(Number(value))?Number(value):NaN;
    const latitude=number(query.latitude),longitude=number(query.longitude);
    const radiusKm=query.radiusKm===undefined?1:number(query.radiusKm);
    const limit=query.limit===undefined?20:number(query.limit);
    if (!Number.isFinite(latitude)||Math.abs(latitude)>90||
        !Number.isFinite(longitude)||Math.abs(longitude)>180||
        !Number.isFinite(radiusKm)||radiusKm<=0||radiusKm>5||
        !Number.isInteger(limit)||limit<1||limit>100) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    const value=await this.call('SearchNearbyDrivers',{latitude,longitude,
      radius_km:radiusKm,limit,...(query.cursor?{cursor:query.cursor}:{})},request,response);
    if (!value) return;
    try {
      const rows=value.items??[];
      if (!Array.isArray(rows)||typeof value.has_more!=='boolean'||
          value.radius_km!==radiusKm||value.limit!==limit||
          (value.has_more!==Boolean(value.next_cursor))) throw new Error('Invalid nearby page');
      const items=rows.map(item=>{
        if (!record(item)||typeof item.driver_id!=='string'||!item.driver_id||
            !['STANDARD','PREMIUM','MOTORBIKE','VAN'].includes(String(item.vehicle_type))||
            !Number.isInteger(item.distance_meters)||Number(item.distance_meters)<0||
            Number(item.distance_meters)%10!==0) throw new Error('Invalid nearby candidate');
        return {driverId:item.driver_id,vehicleType:item.vehicle_type,
          distanceMeters:item.distance_meters};
      });
      if (items.length>limit) throw new Error('Invalid nearby page length');
      response.status(200).json({items,radiusKm,limit,snapshotAt:iso(value.snapshot_at),
        expiresAt:iso(value.expires_at),hasMore:value.has_more,
        ...(value.has_more?{nextCursor:value.next_cursor}:{})});
    } catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('drivers/me')
  async me(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'driver-me')||!this.authorized(request,response)) return;
    const value=await this.call('GetMyDriverProfile',{},request,response);
    if (!value) return;
    try {response.status(200).json(profile(value));}
    catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('drivers/:driverId')
  async byId(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'driver-by-id')||!this.authorized(request,response)) return;
    const driverId=String(request.params.driverId??'');
    if(!driverIdPattern.test(driverId)) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    const value=await this.call('GetDriverById',{driver_id:driverId},request,response);
    if(!value) return;
    if(value.driver_id!==driverId||typeof value.full_name!=='string'||!value.full_name.trim()) {
      response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});
      return;
    }
    response.status(200).json({driverId,fullName:value.full_name});
  }
  @Put('drivers/me/availability')
  async availability(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'driver-availability')||!this.authorized(request,response)) return;
    const body=request.body,key=request.header('Idempotency-Key');
    if (!record(body)||Object.keys(body).sort().join(',')!=='driverStatus,expectedVersion'||
        !Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||
        !['AVAILABLE','OFFLINE'].includes(String(body.driverStatus))||
        (key!==undefined&&!/^[A-Za-z0-9._:-]{1,128}$/.test(key))) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    const value=await this.call('SetMyDriverAvailability',{
      expected_version:String(body.expectedVersion),driver_status:body.driverStatus},
      request,response,key??randomUUID());
    if (!value) return;
    try {response.status(200).json(driver(value));}
    catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Put('drivers/me/location')
  async location(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'driver-location')||!this.authorized(request,response)) return;
    const body=request.body;
    const demoServerTime=process.env.NODE_ENV==='development'&&
      process.env.CAB_DEMO_GPS_SERVER_TIME_ENABLED==='1';
    const keys=record(body)?Object.keys(body).sort().join(','):'';
    const serverTime=demoServerTime&&keys==='latitude,longitude';
    if (!record(body)||(!serverTime&&keys!=='latitude,longitude,recordedAt')||
        typeof body.latitude!=='number'||!Number.isFinite(body.latitude)||Math.abs(body.latitude)>90||
        typeof body.longitude!=='number'||!Number.isFinite(body.longitude)||Math.abs(body.longitude)>180||
        (!serverTime&&(typeof body.recordedAt!=='string'||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(body.recordedAt)||
        !Number.isFinite(Date.parse(body.recordedAt))))) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    const date=serverTime?new Date():new Date(body.recordedAt as string);
    const seconds=String(Math.floor(date.getTime()/1000));
    const value=await this.call('UpdateMyDriverLocation',{latitude:body.latitude,
      longitude:body.longitude,recorded_at:{seconds,nanos:(date.getTime()%1000)*1e6}},request,response);
    if (!value) return;
    try {response.status(200).json(locationResult(value));}
    catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
}
