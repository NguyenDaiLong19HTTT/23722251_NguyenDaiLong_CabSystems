import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createDriverClient } from './prisma/client.js';

export const DRIVER_RUNTIME_DATABASE_URL='DRIVER_RUNTIME_DATABASE_URL';
@Injectable()
export class DriverPersistence implements OnModuleInit,OnModuleDestroy {
  private active?:ReturnType<typeof createDriverClient>;
  constructor(@Inject(DRIVER_RUNTIME_DATABASE_URL) private readonly url:string) {}
  get client():ReturnType<typeof createDriverClient> {
    if (!this.active) throw new Error('Driver persistence is not connected');
    return this.active;
  }
  async onModuleInit():Promise<void> {
    if (this.active) return;
    let target:URL;
    try {target=new URL(this.url);} catch {throw new Error('Driver runtime database configuration is invalid');}
    if (!['postgres:','postgresql:'].includes(target.protocol) ||
        target.username!=='driver_runtime' || target.pathname!=='/cab_driver' || !target.password)
      throw new Error('Driver runtime database configuration is invalid');
    const client=createDriverClient(new PrismaPg({connectionString:this.url,max:4,
      connectionTimeoutMillis:3000,idleTimeoutMillis:1000,
      options:'-c statement_timeout=8000 -c lock_timeout=5000'}));
    try {await client.$connect();await client.$queryRaw`SELECT 1`;this.active=client;}
    catch {await client.$disconnect().catch(()=>undefined);throw new Error('Driver persistence connection failed');}
  }
  async onModuleDestroy():Promise<void> {
    const client=this.active;this.active=undefined;
    if (client) await client.$disconnect().catch(()=>{throw new Error('Driver persistence shutdown failed');});
  }
}
