import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,markWorkerHealthy,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import type {PrismaClient} from './prisma/generated/client.js';

type Sample={sample_id:string;assignment_id:string;trip_id:string;driver_id:string;
  latitude:number;longitude:number;recorded_at:Date;received_at:Date};
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
export class DriverLocationHandoff {
  private readonly trip:grpc.Client;
  private readonly definition=serviceDefinition('cab.internal.v1.TripInternalService',
    'proto/cab/internal/v1/trip.proto');
  private timer?:ReturnType<typeof setTimeout>;
  private stopped=false;
  constructor(private readonly db:PrismaClient) {
    const target=process.env.TRIP_SERVICE_GRPC_TARGET;
    if(!target) throw new Error('Trip location handoff target missing');
    this.trip=createClient(target,readTlsFromEnvironment('DRIVER_SERVICE'),'trip-service');
  }
  start():void {this.stopped=false;this.schedule(0);}
  private schedule(ms:number):void {if(!this.stopped) this.timer=setTimeout(()=>void this.tick(),ms);}
  private async pending():Promise<Sample[]> {
    return this.db.$queryRaw<Sample[]>`
      SELECT s.sample_id,r.assignment_id,r.trip_id,s.driver_id,s.latitude,s.longitude,
        s.recorded_at,s.received_at
      FROM driver_location_sample s
      JOIN driver_reservation r ON r.driver_id=s.driver_id AND r.state='BOUND'
        AND r.trip_id IS NOT NULL AND s.recorded_at>=r.updated_at
        AND s.received_at>=r.updated_at
      WHERE s.handoff_state='PENDING'
      ORDER BY s.received_at,s.sample_id LIMIT 20`;
  }
  private async handoff(row:Sample):Promise<void> {
    const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
    const result=await unaryCall<Record<string,unknown>,Record<string,unknown>>(
      this.trip,this.definition,'RecordAssignedLocation',{
        sample_id:row.sample_id,assignment_id:row.assignment_id,trip_id:row.trip_id,
        driver_id:row.driver_id,point:{latitude:Number(row.latitude),longitude:Number(row.longitude)},
        recorded_at:stamp(row.recorded_at),received_at:stamp(row.received_at)},metadata,900);
    if(result.sample_id!==row.sample_id||result.trip_id!==row.trip_id||
        typeof result.recorded!=='boolean') throw new Error('Trip handoff receipt mismatch');
    await this.db.$executeRaw`UPDATE driver_location_sample SET handoff_state='SENT'
      WHERE sample_id=${row.sample_id}::uuid AND handoff_state='PENDING'`;
  }
  private async tick():Promise<void> {
    try {const rows=await this.pending();
      for(const row of rows) await this.handoff(row);
      markWorkerHealthy('driver','location-handoff');
      this.schedule(rows.length?0:1000);
    } catch {this.schedule(2000);}
  }
  async close():Promise<void> {this.stopped=true;if(this.timer) clearTimeout(this.timer);
    this.trip.close();}
}
