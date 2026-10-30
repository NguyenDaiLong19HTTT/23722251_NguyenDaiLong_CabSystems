import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import type {PrismaClient} from '../infrastructure/prisma/generated/client.js';

type Row={driver_id:string;account_id:string;vehicle_id:string;driver_version:bigint;
  vehicle_version:bigint;latitude:number;longitude:number;recorded_at:Date};
type Dict=Record<string,unknown>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record=(v:unknown):v is Dict=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
const radians=(degrees:number)=>degrees*Math.PI/180;
export function distanceMeters(a:{latitude:number;longitude:number},
  b:{latitude:number;longitude:number}):number {
  const deltaLatitude=radians(b.latitude-a.latitude);
  const deltaLongitude=radians(b.longitude-a.longitude);
  const h=Math.sin(deltaLatitude/2)**2+Math.cos(radians(a.latitude))*
    Math.cos(radians(b.latitude))*Math.sin(deltaLongitude/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}

export class DriverDispatchCandidates {
  private readonly identity:grpc.Client;
  private readonly definition=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  constructor(private readonly db:PrismaClient) {
    const target=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    if (!target) throw new Error('Identity gRPC target is missing');
    this.identity=createClient(target,readTlsFromEnvironment('DRIVER_SERVICE'),'identity-service');
  }
  close():void {this.identity.close();}
  async find(request:unknown):Promise<Dict> {
    const data=record(request)?request:{};
    const point=record(data.pickup)?data.pickup:{};
    const latitude=point.latitude,longitude=point.longitude;
    const radius=data.radius_meters,limit=data.limit,excluded=data.excluded_driver_ids??[];
    if (typeof data.booking_id!=='string'||!uuid.test(data.booking_id)||
        typeof latitude!=='number'||!Number.isFinite(latitude)||Math.abs(latitude)>90||
        typeof longitude!=='number'||!Number.isFinite(longitude)||Math.abs(longitude)>180||
        data.vehicle_type!=='MOTORBIKE'||
        !Number.isInteger(radius)||Number(radius)<1||Number(radius)>5000||
        !Number.isInteger(limit)||Number(limit)<1||Number(limit)>100||
        !Array.isArray(excluded)||excluded.length>100||
        !excluded.every(id=>typeof id==='string'&&uuid.test(id)))
      throw facadeError(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const asOf=new Date();
    const rows=await this.db.$queryRaw<Row[]>`
      SELECT d.driver_id,d.account_id,v.vehicle_id,d.version AS driver_version,
        v.version AS vehicle_version,l.latitude,l.longitude,l.recorded_at
      FROM driver_profile d
      JOIN vehicle_assignment a ON a.driver_id=d.driver_id AND a.ended_at IS NULL
      JOIN vehicle v ON v.vehicle_id=a.vehicle_id
      JOIN driver_location l ON l.driver_id=d.driver_id
      WHERE d.approval_status='APPROVED' AND d.driver_status='AVAILABLE'
        AND v.vehicle_status='ACTIVE' AND v.vehicle_type=${data.vehicle_type}::text
        AND l.recorded_at>=${new Date(asOf.getTime()-30000)}
        AND l.recorded_at<=${asOf}`;
    const blocked=new Set(excluded as string[]);
    const near=rows.filter(row=>!blocked.has(row.driver_id)).map(row=>({row,
      distance:distanceMeters({latitude:latitude as number,longitude:longitude as number},row)}))
      .filter(item=>item.distance<=Number(radius))
      .sort((a,b)=>a.distance-b.distance||a.row.driver_id.localeCompare(b.row.driver_id));
    const candidates:Dict[]=[];
    for(const {row,distance} of near) {
      const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
      let eligibility:Dict;
      try {
        eligibility=await unaryCall<Dict,Dict>(this.identity,this.definition,
          'VerifyAccountEligibility',{account_id:row.account_id,expected_role:'DRIVER'},
          metadata,900);
      } catch(error) {
        if ((error as grpc.ServiceError).code===grpc.status.FAILED_PRECONDITION) continue;
        throw facadeError(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
      }
      if (eligibility.account_id!==row.account_id||eligibility.role!=='DRIVER'||
          !eligibility.verified_at||!eligibility.account_version)
        throw facadeError(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
      candidates.push({driver_id:row.driver_id,driver_account_id:row.account_id,
        vehicle_id:row.vehicle_id,driver_version:String(row.driver_version),
        vehicle_version:String(row.vehicle_version),distance_meters:Math.floor(distance),
        location_recorded_at:stamp(row.recorded_at)});
      if (candidates.length===limit) break;
    }
    return {candidates,as_of:stamp(asOf)};
  }
}
