import {Injectable,OnModuleDestroy,OnModuleInit} from '@nestjs/common';
import pg from 'pg';

@Injectable()
export class PaymentDatabase implements OnModuleInit,OnModuleDestroy {
  private pool?:pg.Pool;
  get client():pg.Pool {if (!this.pool) throw new Error('Payment database unavailable');return this.pool;}
  async onModuleInit():Promise<void> {
    const raw=process.env.CAB_PAYMENT_RUNTIME_URL;
    let url:URL;
    try {url=new URL(raw??'');} catch {throw new Error('Payment runtime configuration invalid');}
    if (!['postgres:','postgresql:'].includes(url.protocol)||url.username!=='payment_runtime'||
        url.pathname!=='/cab_payment'||!url.password)
      throw new Error('Payment runtime configuration invalid');
    const pool=new pg.Pool({connectionString:raw,max:4,connectionTimeoutMillis:3000,
      idleTimeoutMillis:1000,options:'-c statement_timeout=8000 -c lock_timeout=5000'});
    try {await pool.query('SELECT 1');this.pool=pool;}
    catch {await pool.end().catch(()=>undefined);throw new Error('Payment database connection failed');}
  }
  async onModuleDestroy():Promise<void> {
    const pool=this.pool;this.pool=undefined;
    if (pool) await pool.end();
  }
}
