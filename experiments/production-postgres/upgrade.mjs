import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export const names = {
  identity: ['202610020003_identity_foundation','202610020004_identity_evidence_guard',
    '202610030001_session_revocation_guard'],
  customer: ['202610020003_customer_foundation','202610020004_customer_evidence_guard'],
};

export async function verifyUpgrade({ root, secretsDir, admin, url, command, baseEnv }) {
  async function createDatabase(service, suffix) {
    const database = 'cab_' + service + '_' + suffix;
    await admin.query(`CREATE DATABASE ${database} OWNER ${service}_migration`);
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${service}_runtime`);
    const local = new pg.Client({ connectionString: url('postgres',database) });
    await local.connect();
    try {
      await local.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await local.query(`GRANT USAGE ON SCHEMA public TO ${service}_runtime`);
    } finally { await local.end(); }
    return database;
  }
  async function ledger(database) {
    const db = new pg.Client({ connectionString: url('postgres',database) });
    await db.connect();
    try {
      const rows = await db.query('SELECT migration_name,checksum,finished_at FROM _prisma_migrations ORDER BY migration_name');
      return rows.rows;
    } finally { await db.end(); }
  }
  function migrateV1(service, database) {
    const folder = join(secretsDir, service + '-v1');
    const migrations = join(folder,'migrations');
    const first = join(migrations,names[service][0]);
    mkdirSync(first,{recursive:true});
    const source = join(root,'services',service+'-service','src','infrastructure','prisma','migrations');
    copyFileSync(join(source,'migration_lock.toml'),join(migrations,'migration_lock.toml'));
    copyFileSync(join(source,names[service][0],'migration.sql'),join(first,'migration.sql'));
    const config = join(folder,'prisma.config.mjs');
    const schema = join(root,'services',service+'-service','src','infrastructure','prisma','schema.prisma');
    writeFileSync(config,`import { defineConfig } from 'prisma/config';\nexport default defineConfig({\n`+
      ` schema: ${JSON.stringify(schema)}, migrations: { path: ${JSON.stringify(migrations)} },\n`+
      ` datasource: { url: process.env.CAB_UPGRADE_MIGRATION_URL }\n});\n`);
    command(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--config',config],
      {...baseEnv,CAB_UPGRADE_MIGRATION_URL:url(service+'_migration',database)});
  }
  function migrateFull(service, database) {
    const config = `services/${service}-service/src/infrastructure/prisma/prisma.config.ts`;
    command(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--config',config],
      {...baseEnv,['CAB_'+service.toUpperCase()+'_MIGRATION_URL']:url(service+'_migration',database)});
  }
  async function sentinel(service,database,invalid=null) {
    const db = new pg.Client({ connectionString: url(service+'_runtime',database) });
    await db.connect();
    const operation = 'upgrade-' + randomUUID();
    const account = randomUUID(), profile = randomUUID();
    const hash = () => randomBytes(32);
    try {
      await db.query('BEGIN');
      if (service === 'identity') {
        await db.query(`INSERT INTO account(account_id,full_name,email_ciphertext,email_nonce,email_tag,
          email_key_version,phone_ciphertext,phone_nonce,phone_tag,phone_key_version,
          email_lookup_hmac,phone_lookup_hmac,lookup_key_version,password_hash,role,account_status)
          VALUES ($1,'Synthetic',$2,$3,$4,'enc-v1',$2,$3,$4,'enc-v1',$5,$6,'lookup-v1',
          'synthetic-hash','CUSTOMER','ACTIVE')`,
          [account,Buffer.from('cipher'),Buffer.alloc(12),Buffer.alloc(16),hash(),hash()]);
        if (invalid) {
          await db.query(`INSERT INTO registration_operation(operation_id,flow_type,account_id,
            target_profile_id,public_status,internal_phase,idempotency_key_hmac,idempotency_key_version,
            recovery_token_digest,recovery_digest_key_version,request_fingerprint_hmac,
            fingerprint_key_version,result_snapshot_ciphertext,result_snapshot_nonce,result_snapshot_tag,
            result_snapshot_key_version,result_snapshot_format_version,customer_provision_state,
            terminal_at,public_lookup_until)
            VALUES ($1,'CUSTOMER',$2,$3,'SUCCEEDED','SUCCEEDED',$4,'idem-v1',$5,'token-v1',
            $6,'fingerprint-v1',$7,$8,$9,'snapshot-v1',$10,$11,now(),now()+interval '168 hours')`,
            [operation,account,profile,hash(),hash(),hash(),Buffer.from('cipher'),
             Buffer.alloc(12),Buffer.alloc(16),invalid === 'snapshot' ? null : 1,
             invalid === 'terminal' ? null : 'PROVISIONED']);
        } else {
          await db.query(`INSERT INTO registration_operation(operation_id,flow_type,account_id,
            target_profile_id,public_status,internal_phase,idempotency_key_hmac,idempotency_key_version,
            recovery_token_digest,recovery_digest_key_version,request_fingerprint_hmac,
            fingerprint_key_version)
            VALUES ($1,'CUSTOMER',$2,$3,'PROCESSING','PROVISION_PENDING',$4,'idem-v1',
              $5,'token-v1',$6,'fingerprint-v1')`,
            [operation,account,profile,hash(),hash(),hash()]);
          for (const kind of ['EMAIL','PHONE']) await db.query(`INSERT INTO contact_claim
            (claim_id,account_id,operation_id,kind,lookup_hmac,lookup_key_version)
            VALUES ($1,$2,$3,$4,$5,'lookup-v1')`,[randomUUID(),account,operation,kind,hash()]);
        }
      } else {
        await db.query(`INSERT INTO customer_provision(operation_id,account_id,customer_id,state)
          VALUES ($1,$2,$3,'PROVISIONED')`,[operation,account,profile]);
        await db.query(`INSERT INTO customer(customer_id,account_id,provision_operation_id)
          VALUES ($1,$2,$3)`,[profile,account,operation]);
        await db.query(`INSERT INTO customer_rpc_receipt(receipt_id,caller_service,full_method,
          command_id,operation_id,fingerprint_hmac,fingerprint_key_version,result_operation_id,
          result_account_id,result_customer_id,result_state)
          VALUES ($1,'identity-service','/cab.internal.v1.CustomerInternalService/ProvisionCustomer',
            $2,$3,$4,'fingerprint-v1',$3,$5,$6,'PROVISIONED')`,
          [randomUUID(),randomUUID(),operation,hash(),account,profile]);
      }
      await db.query('COMMIT');
      return {operation,account,profile};
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { await db.end(); }
  }
  async function compareStructures(service, upgraded) {
    const capture = async database => {
      const db = new pg.Client({ connectionString: url('postgres',database) });
      await db.connect();
      try {
        const constraints = await db.query(`SELECT c.conname,pg_get_constraintdef(c.oid) definition
          FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
          WHERE n.nspname='public' ORDER BY c.conname,definition`);
        const triggers = await db.query(`SELECT tgname,tgrelid::regclass::text AS table_name,
          pg_get_triggerdef(oid) definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`);
        const functions = await db.query(`SELECT p.proname,pg_get_functiondef(p.oid) definition
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
          ORDER BY p.proname`);
        const grants = await db.query(`SELECT table_name,privilege_type FROM information_schema.role_table_grants
          WHERE grantee=$1 AND table_schema='public' ORDER BY table_name,privilege_type`,
          [service+'_runtime']);
        const columnGrants = await db.query(`SELECT table_name,column_name,privilege_type
          FROM information_schema.column_privileges WHERE grantee=$1 AND table_schema='public'
          ORDER BY table_name,column_name,privilege_type`,[service+'_runtime']);
        assert.ok(grants.rows.length > 0);
        assert.ok(columnGrants.rows.length > 0);
        return {constraints:constraints.rows,triggers:triggers.rows,
          functions:functions.rows,grants:grants.rows,columnGrants:columnGrants.rows};
      } finally { await db.end(); }
    };
    assert.deepEqual(await capture(upgraded),await capture('cab_'+service));
  }

  for (const service of ['identity','customer']) {
    const database = await createDatabase(service,'upgrade');
    migrateV1(service,database);
    const before = await ledger(database);
    assert.deepEqual(before.map(row=>row.migration_name),[names[service][0]]);
    const ids = await sentinel(service,database);
    migrateFull(service,database);
    const after = await ledger(database);
    assert.deepEqual(after.map(row=>row.migration_name),names[service]);
    assert.deepEqual(after[0],before[0]);
    const db = new pg.Client({ connectionString: url(service+'_runtime',database) });
    await db.connect();
    try {
      const table = service === 'identity' ? 'registration_operation' : 'customer_provision';
      const saved = await db.query(`SELECT account_id FROM ${table} WHERE operation_id=$1`,[ids.operation]);
      assert.equal(saved.rows[0].account_id,ids.account);
    } finally { await db.end(); }
    await compareStructures(service,database);
    migrateFull(service,database);
    assert.deepEqual(await ledger(database),after);
    console.info('PASS ' + service + ' V1 sentinel -> V2 / structure / grants / replay');
  }
  for (const kind of ['snapshot','terminal']) {
    const invalid = await createDatabase('identity','invalid_'+kind);
    migrateV1('identity',invalid);
    const invalidIds = await sentinel('identity',invalid,kind);
    let failure;
    try { migrateFull('identity',invalid); } catch (error) { failure = error; }
    assert.ok(failure,'Invalid V1 evidence must block V2 deploy');
    const badLedger = await ledger(invalid);
    assert.deepEqual(badLedger.map(row=>row.migration_name),names.identity.slice(0,2));
    assert.equal(badLedger[1].finished_at,null);
    const db = new pg.Client({ connectionString: url('postgres',invalid) });
    await db.connect();
    try {
      const row = await db.query(`SELECT public_status,result_snapshot_format_version,
        customer_provision_state FROM registration_operation WHERE operation_id=$1`,
        [invalidIds.operation]);
      assert.equal(row.rows[0].public_status,'SUCCEEDED');
      assert.equal(row.rows[0][kind === 'snapshot' ? 'result_snapshot_format_version' :
        'customer_provision_state'],null);
      const log = await db.query(`SELECT logs FROM _prisma_migrations WHERE migration_name=$1`,
        [names.identity[1]]);
      assert.match(log.rows[0].logs,kind === 'snapshot' ? /snapshot format version missing/ :
        /terminal provision state missing/);
    } finally { await db.end(); }
    console.info('PASS invalid V1 ' + kind + ' evidence blocks V2; data and failed ledger retained');
  }
}
