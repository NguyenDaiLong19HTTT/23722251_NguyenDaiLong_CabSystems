import {Injectable,OnModuleDestroy,OnModuleInit} from '@nestjs/common';
import pg from 'pg';

@Injectable()
export class RatingDatabase implements OnModuleInit,OnModuleDestroy {
  private pool?:pg.Pool;
  get client():pg.Pool {if(!this.pool) throw new Error('Rating database unavailable');return this.pool;}
  async onModuleInit():Promise<void> {
    let url:URL;
    try {url=new URL(process.env.CAB_RATING_RUNTIME_URL??'');}
    catch {throw new Error('Rating runtime configuration invalid');}
    if(!['postgres:','postgresql:'].includes(url.protocol)||url.username!=='rating_runtime'||
        url.pathname!=='/cab_rating'||!url.password)
      throw new Error('Rating runtime configuration invalid');
    const pool=new pg.Pool({connectionString:url.toString(),max:4,
      connectionTimeoutMillis:3000,idleTimeoutMillis:1000,
      options:'-c statement_timeout=8000 -c lock_timeout=5000'});
    try {await pool.query('SELECT 1');this.pool=pool;}
    catch {await pool.end().catch(()=>undefined);throw new Error('Rating database connection failed');}
  }
  async onModuleDestroy():Promise<void> {const pool=this.pool;this.pool=undefined;if(pool) await pool.end();}
}
