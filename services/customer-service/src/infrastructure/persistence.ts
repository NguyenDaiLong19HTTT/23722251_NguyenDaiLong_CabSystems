import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

export const CUSTOMER_RUNTIME_DATABASE_URL = 'CUSTOMER_RUNTIME_DATABASE_URL';
export const CUSTOMER_PRISMA_CLIENT_FACTORY = 'CUSTOMER_PRISMA_CLIENT_FACTORY';

export interface CustomerPrismaLifecycleClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export type CustomerPrismaClientFactory = (adapter: PrismaPg) => CustomerPrismaLifecycleClient;

@Injectable()
export class CustomerPersistence implements OnModuleInit, OnModuleDestroy {
  private active?: CustomerPrismaLifecycleClient;

  constructor(
    @Inject(CUSTOMER_RUNTIME_DATABASE_URL) private readonly runtimeUrl: string,
    @Inject(CUSTOMER_PRISMA_CLIENT_FACTORY) private readonly clientFactory: CustomerPrismaClientFactory,
  ) {}

  get client(): CustomerPrismaLifecycleClient {
    if (!this.active) throw new Error('Customer persistence is not connected');
    return this.active;
  }

  async onModuleInit(): Promise<void> {
    if (this.active) return;
    let target: URL;
    try { target = new URL(this.runtimeUrl); }
    catch { throw new Error('Customer runtime database configuration is invalid'); }
    if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
        target.username !== 'customer_runtime' || target.pathname !== '/cab_customer' || !target.password) {
      throw new Error('Customer runtime database configuration is invalid');
    }
    const client = this.clientFactory(new PrismaPg({
      connectionString: this.runtimeUrl,
      max: 4,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 1000,
      options: '-c statement_timeout=8000 -c lock_timeout=5000',
    }));
    try {
      await client.$connect();
      await client.$queryRaw`SELECT 1`;
      this.active = client;
    } catch {
      await client.$disconnect().catch(() => undefined);
      throw new Error('Customer persistence connection failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.active;
    this.active = undefined;
    if (client) {
      try { await client.$disconnect(); }
      catch { throw new Error('Customer persistence shutdown failed'); }
    }
  }
}
