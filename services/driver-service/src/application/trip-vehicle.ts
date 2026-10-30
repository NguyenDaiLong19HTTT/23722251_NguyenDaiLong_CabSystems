import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import type {PrismaClient} from '../infrastructure/prisma/generated/client.js';

type Data=Record<string,unknown>;
const record=(value:unknown):value is Data=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code:grpc.status,reason:string)=>facadeError(code,reason);
export class TripVehicleLookup {
  private readonly trip:grpc.Client;
  private readonly definition=serviceDefinition('cab.internal.v1.TripInternalService',
    'proto/cab/internal/v1/trip.proto');
  constructor(private readonly db:PrismaClient) {
    const target=process.env.TRIP_SERVICE_GRPC_TARGET;
    if(!target) throw new Error('Trip vehicle owner target missing');
    this.trip=createClient(target,readTlsFromEnvironment('DRIVER_SERVICE'),'trip-service');
  }
  close():void {this.trip.close();}
  async get(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const input=record(request)?request:{};
    if(![input.trip_id,input.driver_id,input.vehicle_id]
        .every(value=>typeof value==='string'&&uuid.test(value)))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const token=metadata.get('x-cab-user-authorization')[0];
    if(typeof token!=='string'||!/^Bearer [^\s]+$/.test(token))
      throw facadeError(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    const contextMetadata=new grpc.Metadata();contextMetadata.set('x-correlation-id',randomUUID());
    contextMetadata.set('x-cab-user-authorization',token);
    let context:Data;
    try {context=await unaryCall<Data,Data>(this.trip,this.definition,
      'GetActiveTripContactContext',{trip_id:input.trip_id},contextMetadata,900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if(code===grpc.status.NOT_FOUND) throw fail(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
      if(code===grpc.status.PERMISSION_DENIED) throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      if(code===grpc.status.UNAUTHENTICATED)
        throw facadeError(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    }
    const parties=record(context.parties)?context.parties:{};
    if(context.trip_id!==input.trip_id||parties.driver_id!==input.driver_id||
        parties.vehicle_id!==input.vehicle_id)
      throw fail(grpc.status.FAILED_PRECONDITION,'TRIP_VEHICLE_MISMATCH');
    const rows=await this.db.$queryRaw<{vehicle_id:string;plate_number:string;
      vehicle_type:string}[]>`
      SELECT vehicle_id,plate_number,vehicle_type FROM vehicle
      WHERE vehicle_id=${input.vehicle_id}::uuid`;
    const vehicle=rows[0];
    if(!vehicle||!vehicle.plate_number||
        !['STANDARD','PREMIUM','MOTORBIKE','VAN'].includes(vehicle.vehicle_type))
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return {vehicle_id:vehicle.vehicle_id,plate_number:vehicle.plate_number,
      vehicle_type:vehicle.vehicle_type};
  }
}
