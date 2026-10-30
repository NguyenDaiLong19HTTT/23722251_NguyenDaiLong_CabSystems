import {Injectable,OnModuleDestroy,OnModuleInit} from '@nestjs/common';
import pg from 'pg';

@Injectable()
export class BookingDatabase implements OnModuleInit,OnModuleDestroy {
  private pool?:pg.Pool;
  get client():pg.Pool {if(!this.pool) throw new Error('Booking database unavailable');return this.pool;}
  async onModuleInit():Promise<void> {
    let url:URL;
    try {url=new URL(process.env.CAB_BOOKING_RUNTIME_URL??'');}
    catch {throw new Error('Booking runtime configuration invalid');}
    if(!['postgres:','postgresql:'].includes(url.protocol)||url.username!=='booking_runtime'||
        url.pathname!=='/cab_booking'||!url.password)
      throw new Error('Booking runtime configuration invalid');
    const pool=new pg.Pool({connectionString:url.toString(),max:6,
      connectionTimeoutMillis:3000,idleTimeoutMillis:1000,
      options:'-c statement_timeout=8000 -c lock_timeout=5000'});
    try {await pool.query('SELECT 1');this.pool=pool;}
    catch {await pool.end().catch(()=>undefined);throw new Error('Booking database connection failed');}
  }
  async onModuleDestroy():Promise<void> {const pool=this.pool;this.pool=undefined;if(pool) await pool.end();}
}
