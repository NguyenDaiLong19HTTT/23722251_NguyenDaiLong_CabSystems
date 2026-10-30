import {createHash} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {facadeError} from '@cab/grpc-transport';
import type pg from 'pg';
import {fareForPriceVnd,MOTORBIKE} from '../domain/pricing.js';

type Data=Record<string,unknown>;
type Capture={request_digest:Buffer;snapshot:Data};
type Price={pricing_version_id:string;vehicle_type:string;currency:string;
  base_fare:string;price_per_km:string;price_per_minute:string};
type DbRoute={route_id:string;route_version:string;distance_meters:string};
const record=(value:unknown):value is Data=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reject=(code:grpc.status,reason:string)=>facadeError(code,reason);
function point(value:unknown):{latitude:number;longitude:number}|undefined {
  const location=record(value)?value:undefined;
  const point=record(location?.point)?location.point:undefined;
  if (!point||typeof point.latitude!=='number'||!Number.isFinite(point.latitude)||
      Math.abs(point.latitude)>90||typeof point.longitude!=='number'||
      !Number.isFinite(point.longitude)||Math.abs(point.longitude)>180) return;
  return {latitude:point.latitude,longitude:point.longitude};
}
function accepted(value:unknown):Date|undefined {
  if (!record(value)||typeof value.seconds!=='string'||!/^[0-9]+$/.test(value.seconds)||
      typeof value.nanos!=='number'||!Number.isInteger(value.nanos)||
      value.nanos<0||value.nanos>=1e9) return;
  const epoch=Number(value.seconds)*1000+Math.floor(value.nanos/1e6);
  const date=new Date(epoch);
  return Number.isFinite(epoch)&&!Number.isNaN(date.getTime())?date:undefined;
}
export class PricingCapture {
  constructor(private readonly db:pg.Pool) {}
  async get(request:unknown):Promise<Data> {
    const data=record(request)?request:{};
    const operationId=data.operation_id,pickup=point(data.pickup),destination=point(data.destination);
    const when=accepted(data.booking_accepted_at);
    if (typeof operationId!=='string'||!uuid.test(operationId)||
        !pickup||!destination||!when||
        (pickup.latitude===destination.latitude&&pickup.longitude===destination.longitude))
      throw reject(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const time=data.booking_accepted_at as {seconds:string;nanos:number};
    const pickupLocation=data.pickup as Data,destinationLocation=data.destination as Data;
    const canonical=JSON.stringify([data.vehicle_type,time.seconds,time.nanos,pickup.latitude,
      pickup.longitude,pickupLocation.address,destination.latitude,destination.longitude,
      destinationLocation.address]);
    const requestDigest=createHash('sha256').update(canonical).digest();
    const existing=await this.db.query<Capture>(
      'SELECT request_digest,snapshot FROM pricing_capture WHERE operation_id=$1',[operationId]);
    if (existing.rows[0]) {
      if (!existing.rows[0].request_digest.equals(requestDigest))
        throw reject(grpc.status.ALREADY_EXISTS,'PRICING_CAPTURE_CONFLICT');
      return existing.rows[0].snapshot;
    }
    if (data.vehicle_type!==MOTORBIKE)
      throw reject(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const route=await this.db.query<DbRoute>(`SELECT route_id,route_version,distance_meters
      FROM demo_route WHERE pickup_latitude=$1 AND pickup_longitude=$2
        AND destination_latitude=$3 AND destination_longitude=$4 AND enabled=TRUE
      ORDER BY route_version DESC LIMIT 1`,[
      pickup.latitude,pickup.longitude,destination.latitude,destination.longitude]);
    if (!route.rows[0]) throw reject(grpc.status.FAILED_PRECONDITION,'ROUTE_UNSUPPORTED');
    const price=await this.db.query<Price>(`SELECT * FROM pricing_config
      WHERE vehicle_type=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1`,[
      MOTORBIKE,when]);
    if (!price.rows[0]) throw reject(grpc.status.FAILED_PRECONDITION,'PRICING_UNAVAILABLE');
    const selected=route.rows[0],tariff=price.rows[0];
    const distance=BigInt(selected.distance_meters);
    const total=fareForPriceVnd(distance,tariff.price_per_km);
    const snapshot:Data={pricing_version_id:tariff.pricing_version_id,vehicle_type:MOTORBIKE,
      base_fare:{value:tariff.base_fare},price_per_km:{value:tariff.price_per_km},
      price_per_minute:{value:tariff.price_per_minute},currency:'VND',
      accepted_at:time,route_id:selected.route_id,
      route_version:String(selected.route_version),distance_meters:String(distance),
      total_amount:String(total)};
    await this.db.query(`INSERT INTO pricing_capture(operation_id,request_digest,snapshot,accepted_at)
      VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(operation_id) DO NOTHING`,[
      operationId,requestDigest,JSON.stringify(snapshot),when]);
    const committed=await this.db.query<Capture>(
      'SELECT request_digest,snapshot FROM pricing_capture WHERE operation_id=$1',[operationId]);
    if (!committed.rows[0]) throw reject(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    if (!committed.rows[0].request_digest.equals(requestDigest))
      throw reject(grpc.status.ALREADY_EXISTS,'PRICING_CAPTURE_CONFLICT');
    return committed.rows[0].snapshot;
  }
}
