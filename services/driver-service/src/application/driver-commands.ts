import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall } from '@cab/grpc-transport';
import { DriverLicenseCrypto } from '../infrastructure/license-crypto.js';
import type { PrismaClient } from '../infrastructure/prisma/generated/client.js';

type Data=Record<string,unknown>;
type DriverRow={driver_id:string;account_id:string;license_ciphertext:Uint8Array;
  license_nonce:Uint8Array;license_tag:Uint8Array;license_key_version:string;
  approval_status:string;rejection_reason:string|null;driver_status:string;version:bigint;created_at:Date;updated_at:Date};
type VehicleRow={vehicle_id:string;plate_number:string;vehicle_type:string;vehicle_status:string;
  version:bigint;created_at:Date;updated_at:Date};
type LocationRow={latitude:unknown;longitude:unknown;recorded_at:Date;received_at:Date};
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),nanos:(date.getTime()%1000)*1e6});
const record=(value:unknown):value is Data=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const denied=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>facadeError(code,reason,origin);

export class DriverCommands {
  private readonly identity:grpc.Client;
  private readonly definition=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  private readonly crypto=new DriverLicenseCrypto();
  constructor(private readonly db:PrismaClient) {
    const target=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    if (!target) throw new Error('Identity gRPC target is missing');
    this.identity=createClient(target,readTlsFromEnvironment('DRIVER_SERVICE'),'identity-service');
  }
  close():void {this.identity.close();}
  private async principal(metadata:grpc.Metadata):Promise<{accountId:string;driverId:string}> {
    const user=metadata.get('x-cab-user-authorization')[0];
    if (typeof user!=='string'||!/^Bearer [^\s]+$/.test(user))
      throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    const toIdentity=new grpc.Metadata();
    toIdentity.set('x-correlation-id',randomUUID());toIdentity.set('x-cab-user-authorization',user);
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.definition,'VerifyUserIdentity',
      {allowed_roles:['DRIVER']},toIdentity,900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if (code===grpc.status.UNAUTHENTICATED)
        throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if (code===grpc.status.PERMISSION_DENIED)
        throw denied(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if (value.role!=='DRIVER'||typeof value.account_id!=='string'||
        typeof value.driver_id!=='string'||!value.driver_id)
      throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return {accountId:value.account_id,driverId:value.driver_id};
  }
  private async rows(driverId:string,connection:PrismaClient=this.db) {
    const drivers=await connection.$queryRaw<DriverRow[]>`
      SELECT * FROM driver_profile WHERE driver_id=${driverId}::uuid`;
    if (!drivers[0]) throw denied(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
    const vehicles=await connection.$queryRaw<VehicleRow[]>`
      SELECT v.* FROM vehicle_assignment a JOIN vehicle v ON v.vehicle_id=a.vehicle_id
      WHERE a.driver_id=${driverId}::uuid AND a.ended_at IS NULL`;
    return {driver:drivers[0],vehicle:vehicles[0]};
  }
  private dto(row:DriverRow,vehicle?:VehicleRow):Data {
    return {driver_id:row.driver_id,account_id:row.account_id,
      license_number:this.crypto.open({ciphertext:row.license_ciphertext,nonce:row.license_nonce,
        tag:row.license_tag,keyVersion:row.license_key_version},row.driver_id),
      approval_status:row.approval_status,driver_status:row.driver_status,
      ...(row.rejection_reason?{rejection_reason:row.rejection_reason}:{}),
      ...(vehicle?{vehicle_id:vehicle.vehicle_id}:{}),version:String(row.version),
      created_at:stamp(row.created_at),updated_at:stamp(row.updated_at)};
  }
  private vehicleDto(row:VehicleRow,driverId:string):Data {
    return {vehicle_id:row.vehicle_id,plate_number:row.plate_number,
      vehicle_type:row.vehicle_type,vehicle_status:row.vehicle_status==='ACTIVE'?'VEHICLE_ACTIVE':'VEHICLE_INACTIVE',
      assigned_driver_id:driverId,version:String(row.version),
      created_at:stamp(row.created_at),updated_at:stamp(row.updated_at)};
  }
  async profile(_request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const who=await this.principal(metadata);
    const {driver,vehicle}=await this.rows(who.driverId);
    if (driver.account_id!==who.accountId) throw denied(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
    return {driver:this.dto(driver,vehicle),...(vehicle?{vehicle:this.vehicleDto(vehicle,driver.driver_id)}:{})};
  }
  async publicProfile(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const driverId=record(request)?request.driver_id:undefined;
    if(typeof driverId!=='string'||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(driverId))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const token=metadata.get('x-cab-user-authorization')[0];
    if(typeof token!=='string'||!/^Bearer [^\s]+$/.test(token))
      throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    const rows=await this.db.$queryRaw<{account_id:string}[]>`
      SELECT account_id FROM driver_profile WHERE driver_id=${driverId}::uuid`;
    if(!rows[0]) throw denied(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
    const toIdentity=new grpc.Metadata();toIdentity.set('x-correlation-id',randomUUID());
    toIdentity.set('x-cab-user-authorization',token);
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.definition,'GetAccountContact',
      {account_id:rows[0].account_id,purpose:'DRIVER_PUBLIC_PROFILE'},toIdentity,900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if(code===grpc.status.UNAUTHENTICATED)
        throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if(code===grpc.status.NOT_FOUND||code===grpc.status.PERMISSION_DENIED)
        throw denied(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
      throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if(value.account_id!==rows[0].account_id||typeof value.full_name!=='string'||
        !value.full_name.trim()) throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return {driver_id:driverId,full_name:value.full_name};
  }
  async availability(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const who=await this.principal(metadata);
    const version=record(request)?request.expected_version:undefined;
    const status=record(request)?request.driver_status:undefined;
    const key=metadata.get('x-cab-idempotency-key')[0];
    if (typeof version!=='string'||!/^[1-9]\d*$/.test(version)||
        !['AVAILABLE','OFFLINE'].includes(String(status))||typeof key!=='string'||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return this.db.$transaction(async tx=>{
      const locked=await tx.$queryRaw<DriverRow[]>`
        SELECT * FROM driver_profile WHERE driver_id=${who.driverId}::uuid FOR UPDATE`;
      const row=locked[0];
      if (!row||row.account_id!==who.accountId) throw denied(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
      const receipt=await tx.$queryRaw<{expected_version:bigint;requested_status:string;
        result_json:Data}[]>`SELECT expected_version,requested_status,result_json
          FROM availability_receipt WHERE driver_id=${who.driverId}::uuid AND idempotency_key=${key}`;
      if (receipt[0]) {
        if (String(receipt[0].expected_version)!==version||receipt[0].requested_status!==status)
          throw denied(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
        const vehicle=(await this.rows(who.driverId)).vehicle;
        return {...this.dto(row,vehicle),driver_status:receipt[0].result_json.driverStatus,
          version:String(receipt[0].result_json.version),
          updated_at:receipt[0].result_json.updatedAt};
      }
      if (String(row.version)!==version) throw denied(grpc.status.FAILED_PRECONDITION,'VERSION_CONFLICT');
      const vehicles=await tx.$queryRaw<VehicleRow[]>`
        SELECT v.* FROM vehicle_assignment a JOIN vehicle v ON v.vehicle_id=a.vehicle_id
        WHERE a.driver_id=${who.driverId}::uuid AND a.ended_at IS NULL FOR UPDATE OF a,v`;
      if (status==='AVAILABLE') {
        if (row.approval_status!=='APPROVED'||!vehicles[0]||vehicles[0].vehicle_status!=='ACTIVE')
          throw denied(grpc.status.FAILED_PRECONDITION,'DRIVER_NOT_ELIGIBLE');
        const location=await tx.$queryRaw<LocationRow[]>`
          SELECT * FROM driver_location WHERE driver_id=${who.driverId}::uuid`;
        if (!location[0]||Date.now()-location[0].recorded_at.getTime()>30000) {
          const demo=process.env.NODE_ENV==='development'&&
            process.env.CAB_DEMO_AVAILABILITY_LOCATION_ENABLED==='1';
          if (!demo) throw denied(grpc.status.FAILED_PRECONDITION,'LOCATION_STALE');
          const latitude=Number(process.env.CAB_DEMO_AVAILABILITY_LATITUDE);
          const longitude=Number(process.env.CAB_DEMO_AVAILABILITY_LONGITUDE);
          if (!Number.isFinite(latitude)||Math.abs(latitude)>90||
              !Number.isFinite(longitude)||Math.abs(longitude)>180)
            throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
          const at=new Date();
          await tx.$executeRaw`INSERT INTO driver_location_sample
            (sample_id,driver_id,latitude,longitude,recorded_at,received_at)
            VALUES (${randomUUID()}::uuid,${who.driverId}::uuid,
              ${latitude},${longitude},${at},now())`;
          await tx.$executeRaw`INSERT INTO driver_location
            (driver_id,latitude,longitude,recorded_at,received_at)
            VALUES (${who.driverId}::uuid,${latitude},${longitude},${at},now())
            ON CONFLICT (driver_id) DO UPDATE SET latitude=EXCLUDED.latitude,
              longitude=EXCLUDED.longitude,recorded_at=EXCLUDED.recorded_at,
              received_at=EXCLUDED.received_at
              WHERE driver_location.recorded_at<EXCLUDED.recorded_at`;
        }
      }
      if (row.driver_status==='BUSY') throw denied(grpc.status.ALREADY_EXISTS,'RESOURCE_RESERVED');
      let current=row;
      if (row.driver_status!==status) {
        const changed=await tx.$queryRaw<DriverRow[]>`UPDATE driver_profile
          SET driver_status=${status}::text,version=version+1,updated_at=now()
          WHERE driver_id=${who.driverId}::uuid AND version=${row.version} RETURNING *`;
        if (!changed[0]) throw denied(grpc.status.FAILED_PRECONDITION,'VERSION_CONFLICT');
        current=changed[0];
      }
      const result=this.dto(current,vehicles[0]);
      await tx.$executeRaw`INSERT INTO availability_receipt(receipt_id,driver_id,idempotency_key,
        expected_version,requested_status,result_json) VALUES (${randomUUID()}::uuid,
        ${who.driverId}::uuid,${key},${BigInt(version)},${status}::text,
        ${JSON.stringify({driverStatus:status,version:String(current.version),
          updatedAt:result.updated_at})}::jsonb)`;
      return result;
    });
  }
  private locationDto(row:LocationRow):Data {
    return {latitude:Number(row.latitude),longitude:Number(row.longitude),
      recorded_at:stamp(row.recorded_at),received_at:stamp(row.received_at)};
  }
  async location(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const who=await this.principal(metadata);
    const latitude=record(request)?request.latitude:undefined;
    const longitude=record(request)?request.longitude:undefined;
    const time=record(request)?request.recorded_at:undefined;
    const seconds=record(time)?time.seconds:undefined,nanos=record(time)?time.nanos:undefined;
    if (typeof latitude!=='number'||!Number.isFinite(latitude)||Math.abs(latitude)>90||
        typeof longitude!=='number'||!Number.isFinite(longitude)||Math.abs(longitude)>180||
        typeof seconds!=='string'||!/^\d+$/.test(seconds)||
        typeof nanos!=='number'||!Number.isInteger(nanos)||nanos<0||nanos>=1e9)
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const at=new Date(Number(seconds)*1000+Math.floor(nanos/1e6));
    if (!Number.isFinite(at.getTime())||at.getTime()>Date.now())
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    return this.db.$transaction(async tx=>{
      const driver=await tx.$queryRaw<DriverRow[]>`
        SELECT * FROM driver_profile WHERE driver_id=${who.driverId}::uuid FOR UPDATE`;
      if (!driver[0]||driver[0].account_id!==who.accountId)
        throw denied(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
      const sample=await tx.$queryRaw<LocationRow[]>`
        SELECT latitude,longitude,recorded_at,received_at FROM driver_location_sample
        WHERE driver_id=${who.driverId}::uuid AND recorded_at=${at}`;
      if (sample[0]&&(Number(sample[0].latitude)!==latitude||Number(sample[0].longitude)!==longitude))
        throw denied(grpc.status.ALREADY_EXISTS,'LOCATION_TIMESTAMP_CONFLICT');
      if (!sample[0]) await tx.$executeRaw`INSERT INTO driver_location_sample
        (sample_id,driver_id,latitude,longitude,recorded_at,received_at)
        VALUES (${randomUUID()}::uuid,${who.driverId}::uuid,${latitude},${longitude},${at},now())`;
      const current=await tx.$queryRaw<LocationRow[]>`
        SELECT * FROM driver_location WHERE driver_id=${who.driverId}::uuid`;
      let updated=false;
      if (!current[0]||at.getTime()>current[0].recorded_at.getTime()) {
        await tx.$executeRaw`INSERT INTO driver_location(driver_id,latitude,longitude,recorded_at,received_at)
          VALUES (${who.driverId}::uuid,${latitude},${longitude},${at},now())
          ON CONFLICT (driver_id) DO UPDATE SET latitude=EXCLUDED.latitude,
          longitude=EXCLUDED.longitude,recorded_at=EXCLUDED.recorded_at,
          received_at=EXCLUDED.received_at WHERE driver_location.recorded_at<EXCLUDED.recorded_at`;
        updated=true;
      }
      const latest=await tx.$queryRaw<LocationRow[]>`
        SELECT * FROM driver_location WHERE driver_id=${who.driverId}::uuid`;
      return {location_updated:updated,current_location:this.locationDto(latest[0]!)};
    });
  }
}
