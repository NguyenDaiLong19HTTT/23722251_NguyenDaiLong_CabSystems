import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createIdentityProbe, identityProbeDecimal } from '../../services/identity-service/src/infrastructure/prisma-probe/client.js';
import { createCustomerProbe, customerProbeDecimal } from '../../services/customer-service/src/infrastructure/prisma-probe/client.js';
import type { Prisma as IdentityPrisma } from '../../services/identity-service/src/infrastructure/prisma-probe/generated/client.js';
import type { Prisma as CustomerPrisma } from '../../services/customer-service/src/infrastructure/prisma-probe/generated/client.js';

const decimal = '123456789012345678.123456789012';
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Run via npm.cmd run probe:postgres');
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout: ' + label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function barrier(participants: number) {
  let arrived = 0;
  const gate = deferred<void>();
  return async () => {
    if (++arrived === participants) gate.resolve(undefined);
    await bounded(gate.promise, 'transaction barrier');
  };
}
async function assertSqlState(promise: Promise<unknown>, sqlstate: string) {
  try { await promise; throw new Error('Operation unexpectedly allowed'); }
  catch (error) {
    const value = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } } };
    const original = value.code === sqlstate ? value.code : value.meta?.code ?? value.meta?.driverAdapterError?.cause?.originalCode;
    expect(original, 'Prisma=' + value.code + ', kind=' + value.meta?.driverAdapterError?.cause?.kind).toBe(sqlstate);
  }
}

describe.each(['identity', 'customer'] as const)('%s independent Prisma persistence probe', service => {
  const prefix = 'CAB_PROBE_' + service.toUpperCase();
  const database = 'cab_' + service;
  const otherDatabase = service === 'identity' ? 'cab_customer' : 'cab_identity';
  const identityClient = service === 'identity' ? createIdentityProbe(required(prefix + '_URL')) : undefined;
  const customerClient = service === 'customer' ? createCustomerProbe(required(prefix + '_URL')) : undefined;
  const client = identityClient ?? customerClient!;
  const decimalValue = service === 'identity' ? identityProbeDecimal : customerProbeDecimal;
  // Test-only union of independently generated clients, not a shared ORM model.
  const transaction = <T>(fn: (tx: IdentityPrisma.TransactionClient | CustomerPrisma.TransactionClient) => Promise<T>) =>
    identityClient ? identityClient.$transaction(tx => fn(tx)) : customerClient!.$transaction(tx => fn(tx));
  const observerUrl = new URL(required('CAB_PROBE_ADMIN_URL'));
  observerUrl.pathname = '/' + database; // pg connectionString overrides a separate database property.
  const observer = new Pool({
    connectionString: observerUrl.toString(),
    max: 1, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=5000',
  });
  beforeAll(async () => { await client.$connect(); });
  afterAll(async () => { await client.$disconnect(); await observer.end(); });

  it('migration deploy on empty DB succeeded; replay preserves sentinel and migration ledger', async () => {
    const id = randomUUID();
    await client.probeBusiness.create({ data: { id, amount: decimal } });
    const before = await observer.query('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name');
    expect(before.rows).toHaveLength(2);
    // CLI uses only this service migration credential; no reset/db push/shadow DB.
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config',
      'services/' + service + '-service/src/infrastructure/prisma-probe/prisma.config.ts'], {
      env: { ...process.env, CAB_PROBE_MIGRATION_URL: required(prefix + '_MIGRATION_URL') },
      stdio: 'pipe', timeout: 30000,
    });
    const after = await observer.query('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name');
    expect(after.rows).toEqual(before.rows);
    expect((await client.probeBusiness.findUniqueOrThrow({ where: { id } })).amount.toFixed(12)).toBe(decimal);
  });

  it('business probe and outbox commit together; failure rolls BOTH writes back', async () => {
    const business = randomUUID();
    const outbox = randomUUID();
    await transaction(async tx => {
      await tx.probeBusiness.create({ data: { id: business, amount: decimal } });
      await tx.probeOutbox.create({ data: { id: outbox, businessId: business, payload: 'probe-only' } });
    });
    expect(await client.probeBusiness.count({ where: { id: business } })).toBe(1);
    expect(await client.probeOutbox.count({ where: { id: outbox } })).toBe(1);
    const rolledBusiness = randomUUID();
    const rolledOutbox = randomUUID();
    await expect(transaction(async tx => {
      await tx.probeBusiness.create({ data: { id: rolledBusiness, amount: decimal } });
      await tx.probeOutbox.create({ data: { id: rolledOutbox, businessId: rolledBusiness, payload: 'probe-only' } });
      // Real PostgreSQL PK violation after both writes, no fabricated rollback.
      await tx.probeOutbox.create({ data: { id: rolledOutbox, businessId: rolledBusiness, payload: 'duplicate' } });
    })).rejects.toMatchObject({ code: 'P2002' });
    expect(await client.probeBusiness.count({ where: { id: rolledBusiness } })).toBe(0);
    expect(await client.probeOutbox.count({ where: { id: rolledOutbox } })).toBe(0);
  });

  it('concurrent CAS expectedVersion=0 yields exactly one winner and one conflict', async () => {
    const id = randomUUID();
    await client.probeBusiness.create({ data: { id, amount: decimal } });
    const rendezvous = barrier(2);
    const update = () => transaction(async tx => {
      await rendezvous();
      // Single atomic UPDATE ... WHERE id AND version; no check-then-write.
      const result = await tx.probeBusiness.updateMany({
        where: { id, version: 0 }, data: { version: { increment: 1 } },
      });
      return result.count === 1 ? 'won' : 'conflict';
    });
    expect((await Promise.all([update(), update()])).sort()).toEqual(['conflict', 'won']);
    expect((await client.probeBusiness.findUniqueOrThrow({ where: { id } })).version).toBe(1);
  });

  it('parameterized FOR UPDATE blocks a second transaction; same connection per transaction', async () => {
    const id = randomUUID();
    await client.probeBusiness.create({ data: { id, amount: decimal } });
    const firstLocked = deferred<number>();
    const secondReady = deferred<number>();
    const release = deferred<void>();
    let secondFinished = false;
    const first = transaction(async tx => {
      const [before] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM probe_business WHERE id=${id}::uuid FOR UPDATE`;
      firstLocked.resolve(before!.pid);
      await bounded(release.promise, 'release row lock');
      const [after] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(after!.pid).toBe(before!.pid);
    });
    const firstPid = await bounded(firstLocked.promise, 'first row lock');
    const second = transaction(async tx => {
      const [before] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      secondReady.resolve(before!.pid);
      await tx.$queryRaw`SELECT id FROM probe_business WHERE id=${id}::uuid FOR UPDATE`;
      const [after] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(after!.pid).toBe(before!.pid);
      secondFinished = true;
    });
    try {
      const secondPid = await bounded(secondReady.promise, 'second connection');
      expect(secondPid).not.toBe(firstPid);
      const until = Date.now() + 3000;
      let observed = false;
      // Poll actual server lock state; no arbitrary sleep as evidence.
      while (Date.now() < until) {
        const result = await observer.query<{ blockers: number[] }>(
          'SELECT pg_blocking_pids($1) AS blockers', [secondPid]);
        if (result.rows[0]!.blockers.includes(firstPid)) { observed = true; break; }
      }
      expect(observed).toBe(true);
      expect(secondFinished).toBe(false);
    } finally {
      release.resolve(undefined);
      await Promise.all([first, second]);
    }
    expect(secondFinished).toBe(true);
  });

  it('SQL partial unique index enforces one ACTIVE resource under concurrent inserts', async () => {
    const indexes = await observer.query("SELECT indexdef FROM pg_indexes WHERE indexname='probe_one_active_resource'");
    expect(indexes.rows[0].indexdef).toMatch(/UNIQUE.*resource_id.*WHERE \(active = true\)/i);
    const resourceId = randomUUID();
    const rendezvous = barrier(2);
    const insert = () => transaction(async tx => {
      await rendezvous();
      return tx.probeActiveRight.create({ data: { id: randomUUID(), resourceId, active: true } });
    });
    const results = await Promise.allSettled([insert(), insert()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'P2002' });
    expect(await client.probeActiveRight.count({ where: { resourceId, active: true } })).toBe(1);
    await client.probeActiveRight.updateMany({ where: { resourceId }, data: { active: false } });
    await client.probeActiveRight.create({ data: { id: randomUUID(), resourceId, active: true } });
    expect(await client.probeActiveRight.count({ where: { resourceId } })).toBe(2);
  });

  it('NUMERIC(30,12) decimal roundtrip and arithmetic remain exact without Number', async () => {
    const id = randomUUID();
    await client.probeBusiness.create({ data: { id, amount: decimal } });
    const row = await client.probeBusiness.findUniqueOrThrow({ where: { id } });
    expect(row.amount.toFixed(12)).toBe(decimal);
    expect(decimalValue(row.amount.toFixed(12)).plus('0.000000000001').toFixed(12)).toBe('123456789012345678.123456789013');
    const [raw] = await client.$queryRaw<{ value: string }[]>`SELECT amount::text AS value FROM probe_business WHERE id=${id}::uuid`;
    expect(raw!.value).toBe(decimal);
  });

  it('runtime permits own DML, denies DDL/migration ledger and cross-database access', async () => {
    const [role] = await client.$queryRaw<{ name: string; superuser: boolean; createdb: boolean; createrole: boolean }[]>`
      SELECT rolname AS name, rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole
      FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual({ name: service + '_runtime', superuser: false, createdb: false, createrole: false });
    const [rights] = await client.$queryRaw<{ own: boolean; other: boolean; ddl: boolean; temp: boolean }[]>`
      SELECT has_database_privilege(current_user,current_database(),'CONNECT') AS own,
        has_database_privilege(current_user,${otherDatabase},'CONNECT') AS other,
        has_schema_privilege(current_user,'public','CREATE') AS ddl,
        has_database_privilege(current_user,current_database(),'TEMP') AS temp`;
    expect(rights).toEqual({ own: true, other: false, ddl: false, temp: false });
    await assertSqlState(client.$executeRaw`CREATE TABLE probe_runtime_forbidden(id INT)`, '42501');
    await assertSqlState(client.$executeRaw`ALTER TABLE probe_business ADD COLUMN forbidden INT`, '42501');
    await assertSqlState(client.$queryRaw`SELECT * FROM _prisma_migrations`, '42501');
    const hostileUrl = new URL(required(prefix + '_URL'));
    hostileUrl.pathname = '/' + otherDatabase;
    const hostile = new Pool({ connectionString: hostileUrl.toString(), connectionTimeoutMillis: 3000 });
    try { await assertSqlState(hostile.query('SELECT 1'), '42501'); }
    finally { await hostile.end(); }
    const migration = new Pool({ connectionString: required(prefix + '_MIGRATION_URL'), max: 1 });
    try {
      const attributes = await migration.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
      expect(attributes.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    } finally { await migration.end(); }
  });
});
