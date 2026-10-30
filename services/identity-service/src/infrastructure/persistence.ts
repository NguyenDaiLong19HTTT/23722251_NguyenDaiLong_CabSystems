import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

export const IDENTITY_RUNTIME_DATABASE_URL = 'IDENTITY_RUNTIME_DATABASE_URL';
export const IDENTITY_PRISMA_CLIENT_FACTORY = 'IDENTITY_PRISMA_CLIENT_FACTORY';

export interface IdentityPrismaLifecycleClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export type IdentityPrismaClientFactory = (adapter: PrismaPg) => IdentityPrismaLifecycleClient;

@Injectable()
export class IdentityPersistence implements OnModuleInit, OnModuleDestroy {
  private active?: IdentityPrismaLifecycleClient;

  constructor(
    @Inject(IDENTITY_RUNTIME_DATABASE_URL) private readonly runtimeUrl: string,
    @Inject(IDENTITY_PRISMA_CLIENT_FACTORY) private readonly clientFactory: IdentityPrismaClientFactory,
  ) {}

  get client(): IdentityPrismaLifecycleClient {
    if (!this.active) throw new Error('Identity persistence is not connected');
    return this.active;
  }

  async onModuleInit(): Promise<void> {
    if (this.active) return;
    // Only the service runtime role may reach the application; migration/admin URLs stay in the CLI.
    let target: URL;
    try { target = new URL(this.runtimeUrl); }
    catch { throw new Error('Identity runtime database configuration is invalid'); }
    if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
        target.username !== 'identity_runtime' || target.pathname !== '/cab_identity' || !target.password) {
      throw new Error('Identity runtime database configuration is invalid');
    }
    // PrismaPg owns the pool when constructed from config. Prisma $disconnect disposes it.
    const client = this.clientFactory(new PrismaPg({
      connectionString: this.runtimeUrl,
      max: 4,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 1000,
      options: '-c statement_timeout=8000 -c lock_timeout=5000',
    }));
    try {
      await client.$connect();
      // With this adapter $connect alone can succeed before the first network query.
      await client.$queryRaw`SELECT 1`;
      this.active = client;
    } catch {
      await client.$disconnect().catch(() => undefined);
      throw new Error('Identity persistence connection failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.active;
    this.active = undefined;
    if (client) {
      try { await client.$disconnect(); }
      catch { throw new Error('Identity persistence shutdown failed'); }
    }
  }
}
