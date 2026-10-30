import type pg from 'pg';
import {OwnerClients} from './owner-clients.js';
import {markWorkerHealthy} from '@cab/grpc-transport';
import {record,type Data} from '../application/trip-ledger.js';

type Pending={operation_id:string;trip_id:string;guard_ref:Data;reservation_ref:Data;
  driver_release:string;customer_release:string;payment_fence:string;status:string};
export class ClosureWorker {
  private timer?:ReturnType<typeof setTimeout>;
  private stopped=false;
  constructor(private readonly db:pg.Pool,private readonly owners:OwnerClients) {}
  start():void {this.stopped=false;this.schedule(0);}
  private schedule(ms:number):void {if(!this.stopped) this.timer=setTimeout(()=>void this.tick(),ms);}
  private async pending():Promise<Pending|undefined> {
    const found=await this.db.query<Pending>(`SELECT c.operation_id,c.trip_id,c.driver_release,
      c.customer_release,c.payment_fence,t.guard_ref,t.reservation_ref,t.status
      FROM trip_closure c JOIN trip t ON t.trip_id=c.trip_id
      WHERE (c.driver_release='PENDING' OR c.customer_release='PENDING' OR
        c.payment_fence='PENDING') AND c.next_attempt_at<=now()
      ORDER BY c.created_at LIMIT 1`);
    return found.rows[0];
  }
  private async mark(operationId:string,column:'payment_fence'|'driver_release'|'customer_release') {
    await this.db.query(`UPDATE trip_closure SET ${column}='CONFIRMED',updated_at=now()
      WHERE operation_id=$1 AND ${column}='PENDING'`,[operationId]);
  }
  private async work(row:Pending):Promise<void> {
    if(row.payment_fence==='PENDING') {
      const result=await this.owners.fenceCancellation(row.trip_id,row.operation_id);
      if(!record(result)||result.trip_id!==row.trip_id||result.cancellation_id!==row.operation_id)
        throw new Error('Payment cancellation receipt mismatch');
      await this.mark(row.operation_id,'payment_fence');
    }
    if(row.customer_release==='PENDING') {
      const result=await this.owners.releaseGuard(row.guard_ref,row.trip_id,row.operation_id);
      if(!record(result)||result.state!=='GUARD_RELEASED')
        throw new Error('Customer release receipt mismatch');
      await this.mark(row.operation_id,'customer_release');
    }
    if(row.driver_release==='PENDING') {
      const result=await this.owners.releaseReservation(row.reservation_ref,row.trip_id,row.operation_id);
      if(!record(result)||result.state!=='RELEASED')
        throw new Error('Driver release receipt mismatch');
      await this.mark(row.operation_id,'driver_release');
    }
  }
  private async tick():Promise<void> {
    let row:Pending|undefined;
    try {row=await this.pending();if(row) await this.work(row);
      markWorkerHealthy('trip','trip-closure');this.schedule(row?0:1000);}
    catch {
      if(row) await this.db.query(`UPDATE trip_closure SET attempts=attempts+1,
        next_attempt_at=now()+interval '5 seconds',updated_at=now()
        WHERE operation_id=$1`,[row.operation_id]).catch(()=>undefined);
      this.schedule(2000);
    }
  }
  async close():Promise<void> {this.stopped=true;if(this.timer) clearTimeout(this.timer);}
}
