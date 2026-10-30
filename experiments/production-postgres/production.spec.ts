import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient as IdentityClient } from '../../services/identity-service/src/infrastructure/prisma/generated/client.js';
import { PrismaClient as CustomerClient } from '../../services/customer-service/src/infrastructure/prisma/generated/client.js';
import { IdentityModule } from '../../services/identity-service/src/app.module.js';
import { CustomerModule } from '../../services/customer-service/src/app.module.js';
import { IdentityPersistence } from '../../services/identity-service/src/infrastructure/persistence.js';
import { CustomerPersistence } from '../../services/customer-service/src/infrastructure/persistence.js';
import { persistConfirmedCompensation, findCurrentClaimOwnerByContact,
  findReadyAccountByContactAfterAuthentication } from '../../services/identity-service/src/infrastructure/prisma/registration-persistence.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Run production integration through db:verify');
  return value;
}
const identityUrl = required('CAB_IDENTITY_RUNTIME_URL');
const customerUrl = required('CAB_CUSTOMER_RUNTIME_URL');
const adminUrl = required('CAB_PRODUCTION_ADMIN_URL');
const adminFor = (service: string) => {
  const parsed = new URL(adminUrl);
  parsed.pathname = '/cab_' + service;
  return parsed.toString();
};
const identity = new IdentityClient({ adapter: new PrismaPg({ connectionString: identityUrl, max: 4,
  connectionTimeoutMillis: 3000 }) });
const customer = new CustomerClient({ adapter: new PrismaPg({ connectionString: customerUrl, max: 4,
  connectionTimeoutMillis: 3000 }) });
const digest = (value: string) => createHash('sha256').update(value).digest();
const newId = () => randomUUID();

type Registration = { op: string; account: string; profile: string; email: Uint8Array; phone: Uint8Array };
async function createRegistration(email: Uint8Array = digest(newId()), phone: Uint8Array = digest(newId()),
  claimKinds: readonly ('EMAIL'|'PHONE')[] = ['EMAIL','PHONE']): Promise<Registration> {
  const row = { op: 'op-' + newId(), account: newId(), profile: newId(), email, phone };
  await identity.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO account
      (account_id,full_name,email_ciphertext,email_nonce,email_tag,email_key_version,
       phone_ciphertext,phone_nonce,phone_tag,phone_key_version,email_lookup_hmac,
       phone_lookup_hmac,lookup_key_version,password_hash,role,account_status)
      VALUES (${row.account}::uuid,'Synthetic',${Buffer.from('cipher')},${Buffer.alloc(12,1)},
        ${Buffer.alloc(16,2)},'enc-v1',${Buffer.from('cipher')},${Buffer.alloc(12,3)},
        ${Buffer.alloc(16,4)},'enc-v1',${email},${phone},'lookup-v1','synthetic-hash',
        'CUSTOMER','ACTIVE')`;
    await tx.$executeRaw`INSERT INTO registration_operation
      (operation_id,flow_type,account_id,target_profile_id,public_status,internal_phase,
       idempotency_key_hmac,idempotency_key_version,recovery_token_digest,
       recovery_digest_key_version,request_fingerprint_hmac,fingerprint_key_version)
      VALUES (${row.op},'CUSTOMER',${row.account}::uuid,${row.profile}::uuid,
        'PROCESSING','PROVISION_PENDING',${digest(newId())},'idem-v1',${digest(newId())},
        'token-v1',${digest(newId())},'fingerprint-v1')`;
    for (const [kind, value] of [['EMAIL',email],['PHONE',phone]] as const) {
      if (!claimKinds.includes(kind)) continue;
      await tx.$executeRaw`INSERT INTO contact_claim
        (claim_id,account_id,operation_id,kind,lookup_hmac,lookup_key_version)
        VALUES (${newId()}::uuid,${row.account}::uuid,${row.op},${kind},${value},'lookup-v1')`;
    }
  });
  return row;
}
async function expectPgError(task: Promise<unknown>, code: string, detail?: string) {
  try { await task; throw new Error('Expected PostgreSQL error ' + code); }
  catch (error) {
    expect((error as {code?: string}).code).toBe(code);
    if (detail) expect(String((error as {constraint?: string;message?: string}).constraint ??
      (error as {message?: string}).message)).toContain(detail);
  }
}
async function phase(op: string, next: string) {
  await identity.$executeRaw`UPDATE registration_operation SET internal_phase = ${next},version=version+1
    WHERE operation_id = ${op}`;
}
async function state(op: string) {
  const [row] = await identity.$queryRaw<{ public_status: string; internal_phase: string; version: bigint }[]>`
    SELECT public_status,internal_phase,version FROM registration_operation WHERE operation_id=${op}`;
  return row;
}
async function activeClaim(kind: string, value: Uint8Array) {
  const [row] = await identity.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM contact_claim WHERE kind=${kind} AND lookup_hmac=${value}
      AND released_at IS NULL`;
  return row.n;
}

beforeAll(async () => { await identity.$connect(); await customer.$connect(); });
afterAll(async () => { await identity.$disconnect(); await customer.$disconnect(); });

describe('production Identity/Customer persistence on isolated PostgreSQL', () => {
  it('fresh migration has separate ledgers, tables, constraints and no probe tables', async () => {
    for (const [service,url] of [['identity',identityUrl],['customer',customerUrl]]) {
      const db = new Pool({ connectionString: url, max: 1 });
      try {
        const migration = await db.query('SELECT migration_name,finished_at FROM _prisma_migrations');
        // Runtime must not see the ledger; prove denial in the privilege test below.
        expect(migration.rows).toHaveLength(0);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('42501');
      } finally { await db.end(); }
      const admin = new Pool({ connectionString: adminFor(service), max: 1 });
      try {
        const { rows } = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        expect(rows.some(row => String(row.tablename).startsWith('probe_'))).toBe(false);
        expect(rows.some(row => row.tablename === '_prisma_migrations')).toBe(true);
        const ledger = await admin.query('SELECT migration_name,finished_at FROM _prisma_migrations');
        expect(ledger.rows.map(row=>row.migration_name).sort()).toEqual(service === 'identity'
          ? ['202610020003_identity_foundation','202610020004_identity_evidence_guard',
            '202610030001_session_revocation_guard']
          : ['202610020003_customer_foundation','202610020004_customer_evidence_guard']);
        expect(ledger.rows.every(row=>row.finished_at !== null)).toBe(true);
      } finally { await admin.end(); }
    }
  });

  it('terminal provision state and snapshot format NULL are rejected while PROCESSING NULL remains valid', async () => {
    const db = new Pool({connectionString:identityUrl,max:1});
    try {
      const success = await createRegistration();
      await phase(success.op,'FINALIZING');
      const snapshot = [Buffer.from('cipher'),Buffer.alloc(12),Buffer.alloc(16)];
      await expectPgError(db.query(`UPDATE registration_operation SET public_status='SUCCEEDED',
        internal_phase='SUCCEEDED',terminal_at=now(),public_lookup_until=now()+interval '168 hours',
        result_snapshot_ciphertext=$2,result_snapshot_nonce=$3,result_snapshot_tag=$4,
        result_snapshot_key_version='snapshot-v1',result_snapshot_format_version=1
        WHERE operation_id=$1`,[success.op,...snapshot]),'23514','registration_state_consistency');
      await db.query(`UPDATE registration_operation SET public_status='SUCCEEDED',
        internal_phase='SUCCEEDED',customer_provision_state='PROVISIONED',terminal_at=now(),
        public_lookup_until=now()+interval '168 hours',result_snapshot_ciphertext=$2,
        result_snapshot_nonce=$3,result_snapshot_tag=$4,result_snapshot_key_version='snapshot-v1',
        result_snapshot_format_version=1 WHERE operation_id=$1`,[success.op,...snapshot]);
      await expectPgError(db.query(`UPDATE registration_operation SET result_snapshot_format_version=NULL
        WHERE operation_id=$1`,[success.op]),'23514','registration_snapshot_bundle');
      const failure = await createRegistration();
      await phase(failure.op,'COMPENSATING');
      await expectPgError(db.query(`UPDATE registration_operation SET public_status='FAILED',
        internal_phase='FAILED',terminal_error_code='REGISTRATION_FAILED',terminal_at=now(),
        public_lookup_until=now()+interval '168 hours' WHERE operation_id=$1`,[failure.op]),
        '23514','registration_state_consistency');
      const processing = await createRegistration();
      const row = await db.query(`SELECT customer_provision_state,result_snapshot_format_version
        FROM registration_operation WHERE operation_id=$1`,[processing.op]);
      expect(row.rows[0]).toEqual({customer_provision_state:null,result_snapshot_format_version:null});
    } finally { await db.end(); }
  });

  it('runtime DML works, DDL/ledger/cross-service DB are denied', async () => {
    for (const [service,url,other] of [
      ['identity',identityUrl,'cab_customer'],['customer',customerUrl,'cab_identity'],
    ]) {
      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        const role = await pool.query('SELECT current_user AS role');
        expect(role.rows[0].role).toBe(service + '_runtime');
        const table = service === 'identity' ? 'account' : 'customer_provision';
        await pool.query('SELECT count(*) FROM ' + table);
        const ownedTables = service === 'identity'
          ? ['account','contact_claim','registration_operation','registration_step','session','identity_outbox','identity_audit']
          : ['customer','customer_provision','customer_rpc_receipt','customer_audit'];
        for (const owned of ownedTables) for (const privilege of ['SELECT','INSERT']) {
          const { rows } = await pool.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed',
            [owned,privilege]);
          expect(rows[0].allowed).toBe(true);
        }
        for (const owned of ownedTables) {
          const { rows } = await pool.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed',
            [owned,'DELETE']);
          expect(rows[0].allowed).toBe(service === 'customer' && owned === 'customer');
        }
        await expect(pool.query('CREATE TABLE should_not_exist(id int)'))
          .rejects.toMatchObject({ code: '42501' });
        await expect(pool.query('SELECT * FROM _prisma_migrations'))
          .rejects.toMatchObject({ code: '42501' });
        const foreign = new URL(url); foreign.pathname = '/' + other;
        const denied = new Pool({ connectionString: foreign.toString(), max: 1,
          connectionTimeoutMillis: 3000 });
        try { await expect(denied.query('SELECT 1')).rejects.toMatchObject({ code: '42501' }); }
        finally { await denied.end(); }
      } finally { await pool.end(); }
    }
  });

  it('Identity runtime cannot rewrite evidence or bypass contact release, but progress updates work', async () => {
    const row = await createRegistration();
    const db = new Pool({connectionString:identityUrl,max:1});
    try {
      await expectPgError(db.query('DELETE FROM contact_claim WHERE operation_id=$1',[row.op]),'42501');
      for (const [column,value] of [['kind','PHONE'],['lookup_hmac',digest(newId())],
        ['account_id',newId()],['operation_id','op-'+newId()]] as const) {
        await expectPgError(db.query(`UPDATE contact_claim SET ${column}=$2 WHERE operation_id=$1`,
          [row.op,value]),'42501');
      }
      await expectPgError(db.query(`INSERT INTO contact_claim
        (claim_id,account_id,operation_id,kind,lookup_hmac,lookup_key_version,released_at)
        VALUES ($1,$2,$3,'EMAIL',$4,'lookup-v1',now())`,
        [newId(),row.account,row.op,digest(newId())]),'P0001','pre-released');
      await expectPgError(db.query('UPDATE contact_claim SET released_at=now() WHERE operation_id=$1',
        [row.op]),'P0001','requires confirmed failed');
      await expectPgError(db.query('UPDATE registration_operation SET account_id=$2 WHERE operation_id=$1',
        [row.op,newId()]),'42501');
      const step = newId();
      await db.query(`INSERT INTO registration_step(step_id,operation_id,step_kind,command_id,
        target_service,request_fingerprint_hmac,step_state)
        VALUES ($1,$2,'PROVISION_CUSTOMER',$3,'customer-service',$4,'READY')`,
        [step,row.op,newId(),digest(newId())]);
      await db.query('UPDATE registration_step SET attempt_count=attempt_count+1 WHERE step_id=$1',[step]);
      await expectPgError(db.query('UPDATE registration_step SET command_id=$2 WHERE step_id=$1',
        [step,newId()]),'42501');
      const event = newId();
      await db.query(`INSERT INTO identity_outbox(event_id,aggregate_id,aggregate_version,event_type,
        schema_version,payload,publish_state) VALUES ($1,$2,1,'ACCOUNT_PROVISIONED',1,'{}','PENDING')`,
        [event,row.account]);
      await db.query(`UPDATE identity_outbox SET publish_state='PUBLISHED',published_at=now()
        WHERE event_id=$1`,[event]);
      await expectPgError(db.query('UPDATE identity_outbox SET payload=$2 WHERE event_id=$1',
        [event,'{"changed":true}']),'42501');
      const audit = newId();
      await db.query(`INSERT INTO identity_audit(audit_id,action) VALUES ($1,'REGISTRATION_ACCEPTED')`,[audit]);
      await expectPgError(db.query('UPDATE identity_audit SET action=$2 WHERE audit_id=$1',
        [audit,'REGISTRATION_FAILED']),'42501');
      await expectPgError(db.query('DELETE FROM identity_audit WHERE audit_id=$1',[audit]),'42501');
    } finally { await db.end(); }
  });

  it('Customer receipt/audit are append-only; tombstone binding and cancellation are fenced', async () => {
    const db = new Pool({connectionString:customerUrl,max:1});
    const op='op-'+newId(), account=newId(), profile=newId(), receipt=newId(), audit=newId();
    try {
      await db.query(`INSERT INTO customer_provision(operation_id,account_id,customer_id,state)
        VALUES ($1,$2,$3,'PROVISIONED')`,[op,account,profile]);
      await db.query(`INSERT INTO customer(customer_id,account_id,provision_operation_id)
        VALUES ($1,$2,$3)`,[profile,account,op]);
      await db.query(`INSERT INTO customer_rpc_receipt(receipt_id,caller_service,full_method,
        command_id,operation_id,fingerprint_hmac,fingerprint_key_version,result_operation_id,
        result_account_id,result_customer_id,result_state)
        VALUES ($1,'identity-service','/cab.internal.v1.CustomerInternalService/ProvisionCustomer',
          $2,$3,$4,'fingerprint-v1',$3,$5,$6,'PROVISIONED')`,
        [receipt,newId(),op,digest(newId()),account,profile]);
      await db.query(`INSERT INTO customer_audit(audit_id,action) VALUES ($1,'PROVISIONED')`,[audit]);
      await expectPgError(db.query(`UPDATE customer_rpc_receipt SET result_state='PROVISION_CANCELLED'
        WHERE receipt_id=$1`,[receipt]),'42501');
      await expectPgError(db.query('DELETE FROM customer_rpc_receipt WHERE receipt_id=$1',[receipt]),'42501');
      await expectPgError(db.query(`UPDATE customer_audit SET action='PROVISION_CANCELLED'
        WHERE audit_id=$1`,[audit]),'42501');
      await expectPgError(db.query('DELETE FROM customer_audit WHERE audit_id=$1',[audit]),'42501');
      await expectPgError(db.query('UPDATE customer_provision SET account_id=$2 WHERE operation_id=$1',
        [op,newId()]),'42501');
      await expectPgError(db.query('DELETE FROM customer_provision WHERE operation_id=$1',[op]),'42501');
      await db.query('DELETE FROM customer WHERE customer_id=$1',[profile]);
      await db.query(`UPDATE customer_provision SET state='PROVISION_CANCELLED',
        cancelled_at=now(),version=version+1 WHERE operation_id=$1`,[op]);
      await expectPgError(db.query(`UPDATE customer_provision SET state='PROVISIONED',
        cancelled_at=NULL,version=version+1 WHERE operation_id=$1`,[op]),'P0001','immutable');
      const current = await db.query('SELECT state FROM customer_provision WHERE operation_id=$1',[op]);
      expect(current.rows[0].state).toBe('PROVISION_CANCELLED');
    } finally { await db.end(); }
  });

  it('concurrent contact claims allow one winner, including while PROCESSING and COMPENSATING', async () => {
    const email = digest(newId());
    const outcomes = await Promise.allSettled([createRegistration(email),createRegistration(email)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const first = (outcomes.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Registration>).value;
    expect(await activeClaim('EMAIL',email)).toBe(1n);
    expect(await findCurrentClaimOwnerByContact(identity,'EMAIL',email)).toBe(first.account);
    expect(await findReadyAccountByContactAfterAuthentication(identity,'EMAIL',email)).toBeNull();
    await expect(createRegistration(email)).rejects.toThrow();
    await phase(first.op,'COMPENSATING');
    await expect(createRegistration(email)).rejects.toThrow();
    await expect(identity.$executeRaw`UPDATE contact_claim SET released_at=now()
      WHERE operation_id=${first.op}`).rejects.toThrow();
    expect(await activeClaim('EMAIL',email)).toBe(1n);
  });

  it('FAILED after confirmed compensation releases two claims atomically, preserves evidence and permits new IDs', async () => {
    const email = digest(newId());
    const old = await createRegistration(email);
    await phase(old.op,'COMPENSATING');
    const cancelCommandId = newId();
    await identity.$executeRaw`INSERT INTO registration_step
      (step_id,operation_id,step_kind,command_id,target_service,request_fingerprint_hmac,step_state)
      VALUES (${newId()}::uuid,${old.op},'CANCEL_CUSTOMER_PROVISION',
        ${cancelCommandId}::uuid,'customer-service',${digest(newId())},'READY')`;
    const before = await state(old.op);
    expect(typeof before.version).toBe('bigint');
    // Deliberate fault between decision and claim release; the transaction must roll back.
    await expect(identity.$transaction(async tx => {
      await tx.$executeRaw`UPDATE registration_operation SET public_status='FAILED',
        internal_phase='FAILED',customer_provision_state='PROVISION_CANCELLED',
        terminal_error_code='REGISTRATION_FAILED',terminal_at=now(),
        public_lookup_until=now()+interval '168 hours'
        WHERE operation_id=${old.op}`;
      throw new Error('synthetic fault');
    })).rejects.toThrow('synthetic fault');
    expect(await activeClaim('EMAIL',email)).toBe(1n);
    expect((await state(old.op)).public_status).toBe('PROCESSING');
    await expect(persistConfirmedCompensation(identity, {
      operationId:old.op,accountId:old.account,customerId:old.profile,
      expectedVersion:before.version,cancelCommandId,safeErrorCode:'REGISTRATION_FAILED',
      confirmedCancellation:{operationId:old.op,accountId:old.account,
        customerId:newId(),state:'PROVISION_CANCELLED'},
    })).rejects.toThrow('evidence');
    expect(await activeClaim('EMAIL',email)).toBe(1n);
    expect(await persistConfirmedCompensation(identity, {
      operationId:old.op,accountId:old.account,customerId:old.profile,
      expectedVersion:before.version,cancelCommandId,safeErrorCode:'REGISTRATION_FAILED',
      confirmedCancellation:{operationId:old.op,accountId:old.account,
        customerId:old.profile,state:'PROVISION_CANCELLED'},
    })).toBe(true);
    expect(await activeClaim('EMAIL',email)).toBe(0n);
    const next = await createRegistration(email);
    expect(next.account).not.toBe(old.account);
    expect(next.profile).not.toBe(old.profile);
    expect(next.op).not.toBe(old.op);
    const [oldAccount] = await identity.$queryRaw<{ registration_access_state: string }[]>`
      SELECT registration_access_state FROM account WHERE account_id=${old.account}::uuid`;
    expect(oldAccount.registration_access_state).toBe('FAILED');
    expect(await findCurrentClaimOwnerByContact(identity,'EMAIL',email)).toBe(next.account);
    expect(await findReadyAccountByContactAfterAuthentication(identity,'EMAIL',email)).toBeNull();
    await expect(identity.$executeRaw`INSERT INTO session
      (session_id,account_id,refresh_token_digest,digest_key_version,created_at,expires_at)
      VALUES (${newId()}::uuid,${old.account}::uuid,${digest(newId())},'token-v1',
        now(),now()+interval '168 hours')`).rejects.toThrow();
    const [oldClaim] = await identity.$queryRaw<{ released_at: Date }[]>`
      SELECT released_at FROM contact_claim WHERE operation_id=${old.op} AND kind='EMAIL'`;
    expect(oldClaim.released_at).not.toBeNull();
    expect((await state(old.op)).public_status).toBe('FAILED');
    const [step] = await identity.$queryRaw<{ step_state: string }[]>`
      SELECT step_state FROM registration_step WHERE command_id=${cancelCommandId}::uuid`;
    expect(step.step_state).toBe('CONFIRMED');
    expect(await activeClaim('EMAIL',email)).toBe(1n);
    // Old operation remains addressable by its own key/ID and cannot be redirected to new Account.
    const [oldBinding] = await identity.$queryRaw<{ account_id: string }[]>`
      SELECT account_id FROM registration_operation WHERE operation_id=${old.op}`;
    expect(oldBinding.account_id).toBe(old.account);
  });

  it('adapter late claim-count failure rolls back step, operation, Account, Session and claim', async () => {
    const row = await createRegistration(digest(newId()),digest(newId()),['EMAIL']);
    await phase(row.op,'COMPENSATING');
    const command = newId(), session = newId(), created = new Date();
    await identity.$executeRaw`INSERT INTO registration_step
      (step_id,operation_id,step_kind,command_id,target_service,request_fingerprint_hmac,step_state)
      VALUES (${newId()}::uuid,${row.op},'CANCEL_CUSTOMER_PROVISION',${command}::uuid,
        'customer-service',${digest(newId())},'READY')`;
    // DB-valid defensive fixture: an active Session survived a prior access-state change.
    // Normal registration cannot issue one; this exercises the adapter's revoke write.
    await identity.$executeRaw`UPDATE account SET registration_access_state='READY',
      confirmed_profile_id=${row.profile}::uuid,profile_confirmed_at=now()
      WHERE account_id=${row.account}::uuid`;
    await identity.$executeRaw`INSERT INTO session
      (session_id,account_id,refresh_token_digest,digest_key_version,created_at,expires_at)
      VALUES (${session}::uuid,${row.account}::uuid,${digest(newId())},'token-v1',
        ${created},${new Date(created.getTime()+168*60*60*1000)})`;
    await identity.$executeRaw`UPDATE account SET registration_access_state='BLOCKED',
      confirmed_profile_id=NULL,profile_confirmed_at=NULL WHERE account_id=${row.account}::uuid`;
    const before = await state(row.op);
    const [sessionBefore] = await identity.$queryRaw<{version:bigint;revoked_at:Date|null}[]>`
      SELECT version,revoked_at FROM session WHERE session_id=${session}::uuid`;
    await expect(persistConfirmedCompensation(identity, {
      operationId:row.op,accountId:row.account,customerId:row.profile,
      expectedVersion:before.version,cancelCommandId:command,safeErrorCode:'REGISTRATION_FAILED',
      confirmedCancellation:{operationId:row.op,accountId:row.account,
        customerId:row.profile,state:'PROVISION_CANCELLED'},
    })).rejects.toThrow('contact claim state conflict');
    expect(await state(row.op)).toEqual(before);
    const [step] = await identity.$queryRaw<{step_state:string}[]>`
      SELECT step_state FROM registration_step WHERE command_id=${command}::uuid`;
    const [account] = await identity.$queryRaw<{registration_access_state:string}[]>`
      SELECT registration_access_state FROM account WHERE account_id=${row.account}::uuid`;
    const [sessionAfter] = await identity.$queryRaw<{version:bigint;revoked_at:Date|null}[]>`
      SELECT version,revoked_at FROM session WHERE session_id=${session}::uuid`;
    expect(step.step_state).toBe('READY');
    expect(account.registration_access_state).toBe('BLOCKED');
    expect(sessionAfter).toEqual(sessionBefore);
    expect(await activeClaim('EMAIL',row.email)).toBe(1n);
  });

  it('Customer tombstone keeps all three IDs unique and receipt replay is historical', async () => {
    const op = 'op-' + newId(), account = newId(), profile = newId(), command = newId();
    await customer.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO customer_provision(operation_id,account_id,customer_id,state)
        VALUES (${op},${account}::uuid,${profile}::uuid,'PROVISIONED')`;
      await tx.$executeRaw`INSERT INTO customer(customer_id,account_id,provision_operation_id)
        VALUES (${profile}::uuid,${account}::uuid,${op})`;
      await tx.$executeRaw`INSERT INTO customer_rpc_receipt
        (receipt_id,caller_service,full_method,command_id,operation_id,fingerprint_hmac,
         fingerprint_key_version,result_operation_id,result_account_id,result_customer_id,result_state)
        VALUES (${newId()}::uuid,'identity-service',
        '/cab.internal.v1.CustomerInternalService/ProvisionCustomer',${command}::uuid,
        ${op},${digest(newId())},'fingerprint-v1',${op},${account}::uuid,${profile}::uuid,'PROVISIONED')`;
    });
    await customer.$transaction(async tx => {
      await tx.$executeRaw`DELETE FROM customer WHERE customer_id=${profile}::uuid`;
      await tx.$executeRaw`UPDATE customer_provision SET state='PROVISION_CANCELLED',
        cancelled_at=now(),version=version+1 WHERE operation_id=${op}`;
    });
    const [receipt] = await customer.$queryRaw<{ result_state: string; result_operation_id: string }[]>`
      SELECT result_state,result_operation_id FROM customer_rpc_receipt WHERE command_id=${command}::uuid`;
    const [current] = await customer.$queryRaw<{ state: string }[]>`
      SELECT state FROM customer_provision WHERE operation_id=${op}`;
    expect(receipt).toMatchObject({ result_state:'PROVISIONED', result_operation_id:op });
    expect(current.state).toBe('PROVISION_CANCELLED');
    await expect(customer.$executeRaw`INSERT INTO customer_rpc_receipt
      (receipt_id,caller_service,full_method,command_id,operation_id,fingerprint_hmac,
       fingerprint_key_version,result_operation_id,result_account_id,result_customer_id,result_state)
      VALUES (${newId()}::uuid,'identity-service',
        '/cab.internal.v1.CustomerInternalService/ProvisionCustomer',${command}::uuid,
        ${op},${digest(newId())},'fingerprint-v1',${op},${account}::uuid,${profile}::uuid,'PROVISIONED')`
    ).rejects.toThrow();
    await expect(customer.$executeRaw`INSERT INTO customer_provision(operation_id,account_id,customer_id,state)
      VALUES (${'op-'+newId()},${account}::uuid,${newId()}::uuid,'PROVISIONED')`).rejects.toThrow();
    await expect(customer.$executeRaw`INSERT INTO customer_provision(operation_id,account_id,customer_id,state)
      VALUES (${'op-'+newId()},${newId()}::uuid,${profile}::uuid,'PROVISIONED')`).rejects.toThrow();
    await expect(customer.$executeRaw`INSERT INTO customer_provision(operation_id,account_id,customer_id,state)
      VALUES (${op},${newId()}::uuid,${newId()}::uuid,'PROVISIONED')`).rejects.toThrow();
  });

  it('Cancel before Provision persists an ID fence without a Customer row', async () => {
    const op='op-'+newId(), account=newId(), profile=newId();
    await customer.$executeRaw`INSERT INTO customer_provision
      (operation_id,account_id,customer_id,state,cancelled_at)
      VALUES (${op},${account}::uuid,${profile}::uuid,'PROVISION_CANCELLED',now())`;
    const [row] = await customer.$queryRaw<{ state: string; n: bigint }[]>`
      SELECT p.state,(SELECT count(*) FROM customer c WHERE c.provision_operation_id=p.operation_id) AS n
      FROM customer_provision p WHERE p.operation_id=${op}`;
    expect(row).toMatchObject({state:'PROVISION_CANCELLED',n:0n});
    await expect(customer.$executeRaw`INSERT INTO customer_provision
      (operation_id,account_id,customer_id,state)
      VALUES (${op},${account}::uuid,${profile}::uuid,'PROVISIONED')`).rejects.toThrow();
  });

  it('finalize and COMPENSATING CAS have one winner; rollback leaves no snapshot/outbox', async () => {
    const row = await createRegistration();
    await phase(row.op,'FINALIZING');
    const version = (await state(row.op)).version;
    const finalize = identity.$transaction(async tx => {
      const count = await tx.$executeRaw`UPDATE registration_operation SET public_status='SUCCEEDED',
        internal_phase='SUCCEEDED',customer_provision_state='PROVISIONED',
        result_snapshot_ciphertext=${Buffer.from('synthetic-encrypted-snapshot')},
        result_snapshot_nonce=${Buffer.alloc(12,5)},result_snapshot_tag=${Buffer.alloc(16,6)},
        result_snapshot_key_version='snapshot-v1',result_snapshot_format_version=1,
        terminal_at=now(),public_lookup_until=now()+interval '168 hours',version=version+1
        WHERE operation_id=${row.op} AND version=${version} AND internal_phase='FINALIZING'`;
      if (count === 1) {
        await tx.$executeRaw`UPDATE account SET registration_access_state='READY',
          confirmed_profile_id=${row.profile}::uuid,profile_confirmed_at=now()
          WHERE account_id=${row.account}::uuid AND registration_access_state='BLOCKED'`;
        await tx.$executeRaw`INSERT INTO identity_outbox(event_id,aggregate_id,aggregate_version,
          event_type,schema_version,payload,publish_state)
          VALUES (${newId()}::uuid,${row.account}::uuid,2,'ACCOUNT_PROVISIONED',1,
          ${JSON.stringify({accountId:row.account,customerId:row.profile,operationId:row.op})}::jsonb,'PENDING')`;
      }
      return count;
    });
    const compensate = identity.$executeRaw`UPDATE registration_operation SET internal_phase='COMPENSATING',
      version=version+1 WHERE operation_id=${row.op} AND version=${version} AND internal_phase='FINALIZING'
      AND public_status='PROCESSING'`;
    const counts = await Promise.all([finalize,compensate]);
    expect(counts[0]+counts[1]).toBe(1);
    const [outbox] = await identity.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM identity_outbox WHERE aggregate_id=${row.account}::uuid`;
    expect(outbox.n).toBe(counts[0] === 1 ? 1n : 0n);
    const rollback = await createRegistration();
    await phase(rollback.op,'FINALIZING');
    await expect(identity.$transaction(async tx => {
      await tx.$executeRaw`UPDATE registration_operation SET public_status='SUCCEEDED',
        internal_phase='SUCCEEDED',customer_provision_state='PROVISIONED',
        result_snapshot_ciphertext=${Buffer.from('synthetic')},result_snapshot_nonce=${Buffer.alloc(12)},
        result_snapshot_tag=${Buffer.alloc(16)},result_snapshot_key_version='snapshot-v1',
        result_snapshot_format_version=1,terminal_at=now(),
        public_lookup_until=now()+interval '168 hours' WHERE operation_id=${rollback.op}`;
      await tx.$executeRaw`INSERT INTO identity_outbox(event_id,aggregate_id,aggregate_version,
        event_type,schema_version,payload,publish_state)
        VALUES (${newId()}::uuid,${rollback.account}::uuid,2,'ACCOUNT_PROVISIONED',1,
        ${JSON.stringify({accountId:rollback.account,customerId:rollback.profile,operationId:rollback.op})}::jsonb,
        'PENDING')`;
      throw new Error('synthetic fault');
    })).rejects.toThrow('synthetic fault');
    expect((await state(rollback.op)).public_status).toBe('PROCESSING');
    const [snap] = await identity.$queryRaw<{ result_snapshot_ciphertext: Uint8Array | null }[]>`
      SELECT result_snapshot_ciphertext FROM registration_operation WHERE operation_id=${rollback.op}`;
    expect(snap.result_snapshot_ciphertext).toBeNull();
    const [undoneOutbox] = await identity.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM identity_outbox WHERE aggregate_id=${rollback.account}::uuid`;
    expect(undoneOutbox.n).toBe(0n);
  });

  it('Session absolute expiry, nullable snapshot and registration gate CHECKs reject invalid rows', async () => {
    const row = await createRegistration();
    await expect(identity.$executeRaw`INSERT INTO session
      (session_id,account_id,refresh_token_digest,digest_key_version,expires_at)
      VALUES (${newId()}::uuid,${row.account}::uuid,${digest(newId())},'token-v1',
        now()+interval '168 hours')`).rejects.toThrow();
    await expect(identity.$executeRaw`UPDATE registration_operation SET public_status='SUCCEEDED'
      WHERE operation_id=${row.op}`).rejects.toThrow();
    await phase(row.op,'FINALIZING');
    await identity.$executeRaw`UPDATE registration_operation SET public_status='SUCCEEDED',
      internal_phase='SUCCEEDED',customer_provision_state='PROVISIONED',
      result_snapshot_ciphertext=${Buffer.from('synthetic')},result_snapshot_nonce=${Buffer.alloc(12)},
      result_snapshot_tag=${Buffer.alloc(16)},result_snapshot_key_version='snapshot-v1',
      result_snapshot_format_version=1,terminal_at=now(),
      public_lookup_until=now()+interval '168 hours' WHERE operation_id=${row.op}`;
    await identity.$executeRaw`UPDATE account SET registration_access_state='READY',
      confirmed_profile_id=${row.profile}::uuid,profile_confirmed_at=now()
      WHERE account_id=${row.account}::uuid`;
    const session = newId(), created = new Date();
    await identity.$executeRaw`INSERT INTO session
      (session_id,account_id,refresh_token_digest,digest_key_version,created_at,expires_at)
      VALUES (${session}::uuid,${row.account}::uuid,${digest(newId())},'token-v1',
        ${created},${new Date(created.getTime()+7*24*60*60*1000)})`;
    await expect(identity.$executeRaw`UPDATE session SET expires_at=expires_at+interval '1 hour'
      WHERE session_id=${session}::uuid`).rejects.toThrow();
    const runtime = new Pool({connectionString:identityUrl,max:1});
    try {
      await expectPgError(runtime.query(`UPDATE session SET created_at=created_at+interval '1 hour',
        expires_at=expires_at+interval '1 hour' WHERE session_id=$1`,[session]),'42501');
      await expectPgError(runtime.query('UPDATE session SET account_id=$2 WHERE session_id=$1',
        [session,newId()]),'42501');
      const before = await runtime.query('SELECT created_at,expires_at FROM session WHERE session_id=$1',[session]);
      await runtime.query(`UPDATE session SET refresh_token_digest=$2,rotated_at=now(),version=version+1
        WHERE session_id=$1`,[session,digest(newId())]);
      const after = await runtime.query('SELECT created_at,expires_at,version,rotated_at FROM session WHERE session_id=$1',
        [session]);
      expect(after.rows[0].created_at).toEqual(before.rows[0].created_at);
      expect(after.rows[0].expires_at).toEqual(before.rows[0].expires_at);
      expect(after.rows[0].version).toBe('2'); // pg returns BIGINT as a string; no JS Number coercion.
      expect(after.rows[0].rotated_at).not.toBeNull();
      await runtime.query('UPDATE session SET revoked_at=now(),version=version+1 WHERE session_id=$1',[session]);
      const revoked = await runtime.query(`SELECT revoked_at,refresh_token_digest,rotated_at
        FROM session WHERE session_id=$1`,[session]);
      await expectPgError(runtime.query('UPDATE session SET revoked_at=NULL WHERE session_id=$1',
        [session]),'P0001');
      await expectPgError(runtime.query(`UPDATE session SET refresh_token_digest=$2
        WHERE session_id=$1`,[session,digest(newId())]),'P0001');
      await expectPgError(runtime.query(`UPDATE session SET rotated_at=now()+interval '1 minute'
        WHERE session_id=$1`,[session]),'P0001');
      await runtime.query('UPDATE session SET revoked_at=revoked_at WHERE session_id=$1',[session]);
      const repeated = await runtime.query(`SELECT revoked_at,refresh_token_digest,rotated_at
        FROM session WHERE session_id=$1`,[session]);
      expect(repeated.rows[0]).toEqual(revoked.rows[0]);
    } finally { await runtime.end(); }
    const email = row.email;
    expect(await findCurrentClaimOwnerByContact(identity,'EMAIL',email)).toBe(row.account);
    expect(await findReadyAccountByContactAfterAuthentication(identity,'EMAIL',email)).toBe(row.account);
    await identity.$executeRaw`UPDATE account SET account_status='INACTIVE'
      WHERE account_id=${row.account}::uuid`;
    expect(await activeClaim('EMAIL',email)).toBe(1n);
    expect(await findCurrentClaimOwnerByContact(identity,'EMAIL',email)).toBe(row.account);
    expect(await findReadyAccountByContactAfterAuthentication(identity,'EMAIL',email)).toBeNull();
    await expect(createRegistration(email)).rejects.toThrow();
    await identity.$executeRaw`UPDATE account SET account_status='SUSPENDED'
      WHERE account_id=${row.account}::uuid`;
    expect(await activeClaim('EMAIL',email)).toBe(1n);
    await expect(createRegistration(email)).rejects.toThrow();
  });

  it.each([['identity',IdentityModule,IdentityPersistence,identityUrl],
    ['customer',CustomerModule,CustomerPersistence,customerUrl]] as const)(
    '%s production Nest module boots, queries and closes every tagged DB connection',
    async (service, module, provider, url) => {
      const tag = 'cab_production_' + newId();
      const tagged = new URL(url); tagged.searchParams.set('application_name',tag);
      const variable = service === 'identity' ? 'CAB_IDENTITY_RUNTIME_URL' : 'CAB_CUSTOMER_RUNTIME_URL';
      const previous = process.env[variable]; process.env[variable] = tagged.toString();
      const admin = new Pool({ connectionString: adminFor(service), max:1 });
      try {
        const app = await NestFactory.createApplicationContext(module, { logger:false, abortOnError:false });
        try {
          const persistence = app.get(provider);
          const [row] = await persistence.client.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
          expect(row.role).toBe(service+'_runtime');
          const seen = await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1',[tag]);
          expect(seen.rows[0].n).toBeGreaterThan(0);
        } finally { await app.close(); }
        const gone = await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1',[tag]);
        expect(gone.rows[0].n).toBe(0);
      } finally {
        if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
        await admin.end();
      }
    });
});
