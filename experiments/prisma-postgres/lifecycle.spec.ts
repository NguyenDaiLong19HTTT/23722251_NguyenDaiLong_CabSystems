import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient as IdentityClient } from '../../services/identity-service/src/infrastructure/prisma-probe/generated/client.js';
import { PrismaClient as CustomerClient } from '../../services/customer-service/src/infrastructure/prisma-probe/generated/client.js';
import type { Prisma as IdentityPrisma } from '../../services/identity-service/src/infrastructure/prisma-probe/generated/client.js';
import type { Prisma as CustomerPrisma } from '../../services/customer-service/src/infrastructure/prisma-probe/generated/client.js';
import { IdentityPersistence, IDENTITY_PRISMA_CLIENT_FACTORY, IDENTITY_RUNTIME_DATABASE_URL } from '../../services/identity-service/src/infrastructure/persistence.js';
import { CustomerPersistence, CUSTOMER_PRISMA_CLIENT_FACTORY, CUSTOMER_RUNTIME_DATABASE_URL } from '../../services/customer-service/src/infrastructure/persistence.js';

@Module({})
class PersistenceHarnessModule {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Run lifecycle integration through probe:postgres');
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

type LifecycleCounts = { factory: number; connect: number; disconnect: number };

describe.each(['identity', 'customer'] as const)('%s Nest persistence lifecycle on real PostgreSQL', service => {
  const url = required('CAB_PROBE_' + service.toUpperCase() + '_URL');
  const provider = service === 'identity' ? IdentityPersistence : CustomerPersistence;
  const urlToken = service === 'identity' ? IDENTITY_RUNTIME_DATABASE_URL : CUSTOMER_RUNTIME_DATABASE_URL;
  const factoryToken = service === 'identity' ? IDENTITY_PRISMA_CLIENT_FACTORY : CUSTOMER_PRISMA_CLIENT_FACTORY;
  const moduleFor = (runtimeUrl: string, counts: LifecycleCounts): DynamicModule => ({
    module: PersistenceHarnessModule,
    providers: [provider, { provide: urlToken, useValue: runtimeUrl },
      { provide: factoryToken, useValue: (adapter: PrismaPg) => {
        counts.factory++;
        // Wrap the real generated client; database calls and adapter are never mocked.
        const client = service === 'identity' ? new IdentityClient({ adapter }) : new CustomerClient({ adapter });
        const connect = client.$connect.bind(client);
        const disconnect = client.$disconnect.bind(client);
        client.$connect = async () => { counts.connect++; await connect(); };
        client.$disconnect = async () => { counts.disconnect++; await disconnect(); };
        return client;
      } }],
  });

  it('one real client per context; concurrent connections all close on repeated Nest boot/close', async () => {
    const observerUrl = new URL(required('CAB_PROBE_ADMIN_URL'));
    observerUrl.pathname = '/cab_' + service;
    const observer = new Pool({ connectionString: observerUrl.toString(), max: 1,
      connectionTimeoutMillis: 5000 });
    const pids: number[] = [];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const counts: LifecycleCounts = { factory: 0, connect: 0, disconnect: 0 };
        const tag = 'cab_probe_lifecycle_' + randomUUID();
        const taggedUrl = new URL(url);
        taggedUrl.searchParams.set('application_name', tag);
        const app = await NestFactory.createApplicationContext(moduleFor(taggedUrl.toString(), counts), {
          logger: false, abortOnError: false,
        });
        const entered = deferred();
        const release = deferred();
        const acquired = new Set<number>();
        let transactions: Promise<number[]> | undefined;
        try {
          const resolved = app.get(provider);
          expect(resolved.client).toBe(resolved.client);
          expect(counts).toEqual({ factory: 1, connect: 1, disconnect: 0 });
          const client = resolved.client as IdentityClient | CustomerClient;
          // Each held transaction uses a distinct connection; no sleep or mock as concurrency evidence.
          const hold = () => {
            const callback = async (tx: IdentityPrisma.TransactionClient | CustomerPrisma.TransactionClient) => {
            const [row] = await tx.$queryRaw<{ pid: number; role: string }[]>`
              SELECT pg_backend_pid() AS pid, current_user AS role`;
            expect(row?.role).toBe(service + '_runtime');
            acquired.add(row!.pid);
            if (acquired.size === 3) entered.resolve();
            await bounded(release.promise, 'release held transaction');
            return row!.pid;
            };
            return service === 'identity' ?
              (client as IdentityClient).$transaction(tx => callback(tx)) :
              (client as CustomerClient).$transaction(tx => callback(tx));
          };
          transactions = Promise.all([hold(), hold(), hold()]);
          await bounded(entered.promise, 'three independent connections');
          const active = await observer.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND datname=$2 AND usename=$3`,
            [tag, 'cab_' + service, service + '_runtime']);
          expect(new Set(active.rows.map(row => row.pid))).toEqual(acquired);
          expect(acquired.size).toBe(3);
        } finally {
          release.resolve();
          try {
            if (transactions) await bounded(transactions, 'held transactions finish');
          } finally { await app.close(); }
        }
        expect(counts).toEqual({ factory: 1, connect: 1, disconnect: 1 });
        // Count every backend tagged to this context, rather than checking just sampled PIDs.
        const remaining = await observer.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND datname=$2 AND usename=$3`,
          [tag, 'cab_' + service, service + '_runtime']);
        expect(remaining.rows[0].n).toBe(0);
        pids.push(...acquired);
      }
      expect(new Set(pids).size).toBe(6);
    } finally { await observer.end(); }
  });

  it('connection failure is bounded and its error does not disclose credentials', async () => {
    const counts: LifecycleCounts = { factory: 0, connect: 0, disconnect: 0 };
    const unreachable = new URL(url);
    unreachable.port = '1';
    const started = Date.now();
    let message = '';
    try {
      const app = await NestFactory.createApplicationContext(moduleFor(unreachable.toString(), counts), {
        logger: false, abortOnError: false,
      });
      await app.close();
      throw new Error('Unexpected database connection success');
    } catch (error) { message = (error as Error).message; }
    expect(Date.now() - started).toBeLessThan(7000);
    expect(message).toBe(service === 'identity' ?
      'Identity persistence connection failed' : 'Customer persistence connection failed');
    expect(message).not.toContain(decodeURIComponent(new URL(url).password));
    expect(counts).toEqual({ factory: 1, connect: 1, disconnect: 1 });
  });

  it('rejects migration role before creating any client or opening a connection', async () => {
    const counts: LifecycleCounts = { factory: 0, connect: 0, disconnect: 0 };
    const migration = new URL(url);
    migration.username = service + '_migration';
    const started = Date.now();
    await expect(NestFactory.createApplicationContext(moduleFor(migration.toString(), counts), {
      logger: false, abortOnError: false,
    })).rejects.toThrow(service === 'identity' ?
      'Identity runtime database configuration is invalid' :
      'Customer runtime database configuration is invalid');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(counts).toEqual({ factory: 0, connect: 0, disconnect: 0 });
  });
});
