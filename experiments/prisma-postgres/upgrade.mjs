// Test-only orchestration. All paths and databases belong to the caller's fresh project.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export function migrationFixture(root, secretsDir, service, stages) {
  const source = join(root, 'services', service + '-service', 'src/infrastructure/prisma-probe');
  const destination = join(secretsDir, service + '-' + stages.join('-'));
  const migrations = join(destination, 'migrations');
  mkdirSync(migrations, { recursive: true });
  copyFileSync(join(source, 'migrations/migration_lock.toml'), join(migrations, 'migration_lock.toml'));
  for (const stage of stages) {
    const name = stage === 1 ? '202610020001_probe' : '202610020002_probe_upgrade';
    mkdirSync(join(migrations, name));
    copyFileSync(join(source, 'migrations', name, 'migration.sql'), join(migrations, name, 'migration.sql'));
  }
  const config = join(destination, 'prisma.config.ts');
  writeFileSync(config, `import { defineConfig } from 'prisma/config';\n` +
    `export default defineConfig({ schema: ${JSON.stringify(join(source, 'schema.prisma'))}, ` +
    `migrations: { path: ${JSON.stringify(migrations)} }, ` +
    `datasource: { url: process.env.CAB_PROBE_MIGRATION_URL } });\n`);
  return { config, migrations };
}

export function deploy(root, config, migrationUrl, expectedFailure = false) {
  const result = spawnSync(process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config], {
      cwd: root, env: { ...process.env, CAB_PROBE_MIGRATION_URL: migrationUrl },
      encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
  if (result.error) throw new Error('Migration subprocess did not finish');
  if (expectedFailure) {
    const output = result.stdout + result.stderr;
    if (result.status === 0 || (expectedFailure === 'apply' &&
        !output.includes('Applying migration `202610020003_intentional_failure`')) ||
        (expectedFailure === 'blocked' && !/P3009|failed migration/i.test(output))) {
      throw new Error('Expected migration failure state was not reported; phase=' + expectedFailure);
    }
    return;
  }
  if (result.status !== 0) throw new Error('Migration deploy failed; inspect disposable project before cleanup');
}

async function database(admin, adminUrl, url, name, service) {
  await admin.query('CREATE DATABASE ' + name + ' OWNER ' + service + '_migration');
  await admin.query('REVOKE ALL ON DATABASE ' + name + ' FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE ' + name + ' TO ' + service + '_runtime');
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = '/' + name;
  const connection = new pg.Client({ connectionString: dbUrl.toString(), connectionTimeoutMillis: 5000 });
  await connection.connect();
  try {
    await connection.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await connection.query('GRANT USAGE ON SCHEMA public TO ' + service + '_runtime');
  } finally { await connection.end(); }
  return url(service + '_migration', name);
}

async function pool(connectionString) {
  const result = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=8000 -c lock_timeout=5000' });
  await result.query('SELECT 1');
  return result;
}

async function structure(adminUrl, databaseName, runtimeRole) {
  const target = new URL(adminUrl);
  target.pathname = '/' + databaseName;
  const observer = await pool(target.toString());
  try {
    const columns = await observer.query(`SELECT table_name,column_name,data_type,is_nullable,column_default,
      numeric_precision,numeric_scale
      FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'probe_%'
      ORDER BY table_name,column_name`);
    const indexes = await observer.query(`SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename LIKE 'probe_%' ORDER BY indexname`);
    const constraints = await observer.query(`SELECT c.relname AS table_name,k.conname AS name,
      k.contype AS kind,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'probe_%'
      ORDER BY c.relname,k.conname`);
    const grants = await observer.query(`SELECT table_name,privilege_type FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name LIKE 'probe_%' AND grantee=$1
      ORDER BY table_name,privilege_type`, [runtimeRole]);
    return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows,
      grants: grants.rows };
  } finally { await observer.end(); }
}

export async function runUpgrade(root, secretsDir, admin, adminUrl, url, service) {
  const name = 'cab_' + service;
  const runtimeUrl = url(service + '_runtime', name);
  const migrationUrl = url(service + '_migration', name);
  const v1 = migrationFixture(root, secretsDir, service, [1]);
  deploy(root, v1.config, migrationUrl);
  const runtime = await pool(runtimeUrl);
  const sentinel = randomUUID();
  const resource = randomUUID();
  try {
    await runtime.query('INSERT INTO probe_business(id,amount) VALUES($1,$2)',
      [sentinel, '123456789012345678.123456789012']);
    await runtime.query('INSERT INTO probe_active_right(id,resource_id,active) VALUES($1,$2,TRUE)',
      [randomUUID(), resource]);
  } finally { await runtime.end(); }
  console.info('PASS ' + service + ' V1 empty apply and runtime sentinel before V2');

  const sourceConfig = join(root, 'services', service + '-service',
    'src/infrastructure/prisma-probe/prisma.config.ts');
  deploy(root, sourceConfig, migrationUrl);
  const upgraded = await pool(runtimeUrl);
  try {
    const kept = await upgraded.query('SELECT amount::text,probe_note FROM probe_business WHERE id=$1', [sentinel]);
    if (kept.rows.length !== 1 || kept.rows[0].amount !== '123456789012345678.123456789012' ||
        kept.rows[0].probe_note !== 'v2') throw new Error('V2 did not preserve V1 sentinel/default');
    await upgraded.query('INSERT INTO probe_upgrade_audit(id,business_id,marker) VALUES($1,$2,$3)',
      [randomUUID(), sentinel, 'upgrade']);
    const audit = await upgraded.query('SELECT marker FROM probe_upgrade_audit WHERE business_id=$1', [sentinel]);
    if (audit.rows[0]?.marker !== 'upgrade') throw new Error('Runtime cannot use V2 object');
    try {
      await upgraded.query('INSERT INTO probe_upgrade_audit(id,business_id,marker) VALUES($1,$2,$3)',
        [randomUUID(), randomUUID(), 'orphan']);
      throw new Error('V2 FK no longer enforces local business reference');
    } catch (error) {
      if (error.code !== '23503') throw error;
    }
    try {
      await upgraded.query('INSERT INTO probe_upgrade_audit(id,business_id,marker) VALUES($1,$2,$3)',
        [randomUUID(), sentinel, '']);
      throw new Error('V2 CHECK constraint is no longer enforced');
    } catch (error) {
      if (error.code !== '23514') throw error;
    }
    try {
      await upgraded.query('UPDATE probe_business SET version=-1 WHERE id=$1', [sentinel]);
      throw new Error('V1 CHECK constraint is no longer enforced');
    } catch (error) {
      if (error.code !== '23514') throw error;
    }
    try {
      await upgraded.query('INSERT INTO probe_active_right(id,resource_id,active) VALUES($1,$2,TRUE)',
        [randomUUID(), resource]);
      throw new Error('V1 partial unique index no longer enforces invariant');
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
  } finally { await upgraded.end(); }
  const main = await structure(adminUrl, name, service + '_runtime');
  if (!main.columns.some(row => row.table_name === 'probe_upgrade_audit') ||
      !main.indexes.some(row => row.indexname === 'probe_one_active_resource') ||
      !main.columns.some(row => row.table_name === 'probe_business' && row.column_name === 'amount' &&
        row.numeric_precision === 30 && row.numeric_scale === 12) ||
      !main.constraints.some(row => row.kind === 'c' && row.table_name === 'probe_business') ||
      !main.constraints.some(row => row.kind === 'c' && row.table_name === 'probe_upgrade_audit') ||
      !main.constraints.some(row => row.kind === 'f' && row.table_name === 'probe_outbox') ||
      !main.constraints.some(row => row.kind === 'f' && row.table_name === 'probe_upgrade_audit') ||
      main.grants.filter(row => row.table_name === 'probe_upgrade_audit').length !== 4) {
    throw new Error('Expected V1/V2 catalog constraints, NUMERIC(30,12), index or runtime grants missing');
  }
  for (const table of ['probe_business', 'probe_outbox', 'probe_active_right', 'probe_upgrade_audit']) {
    const actual = main.grants.filter(row => row.table_name === table).map(row => row.privilege_type).sort();
    if (JSON.stringify(actual) !== JSON.stringify(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])) {
      throw new Error('Unexpected runtime grant matrix for ' + table);
    }
  }
  const before = await migrationLedger(adminUrl, name);
  if (before.length !== 2) throw new Error('Expected exactly V1 and V2 migration receipts');
  deploy(root, sourceConfig, migrationUrl);
  const after = await migrationLedger(adminUrl, name);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Deploy replay changed migration history');
  const replay = await pool(runtimeUrl);
  try {
    if ((await replay.query('SELECT count(*)::int AS n FROM probe_upgrade_audit WHERE business_id=$1',
      [sentinel])).rows[0].n !== 1) throw new Error('Deploy replay lost V2 data');
  } finally { await replay.end(); }
  console.info('PASS ' + service + ' V2 upgrade, V1 index, V2 runtime grants and replay');

  const freshName = name + '_fresh';
  const freshMigration = await database(admin, adminUrl, url, freshName, service);
  deploy(root, sourceConfig, freshMigration);
  const fresh = await structure(adminUrl, freshName, service + '_runtime');
  if (JSON.stringify(fresh) !== JSON.stringify(main) ||
      (await migrationLedger(adminUrl, freshName)).length !== 2) {
    throw new Error('Fresh V1+V2 structure differs from upgraded database');
  }
  const freshRuntime = await pool(url(service + '_runtime', freshName));
  try {
    const role = await freshRuntime.query(`SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl,
      has_database_privilege(current_user,current_database(),'CONNECT') AS own`);
    if (role.rows[0].ddl !== false || role.rows[0].own !== true) {
      throw new Error('Fresh install runtime schema/database privileges differ');
    }
    const freshBusiness = randomUUID();
    await freshRuntime.query('INSERT INTO probe_business(id,amount) VALUES($1,$2)', [freshBusiness, '1.000000000000']);
    await freshRuntime.query('INSERT INTO probe_upgrade_audit(id,business_id,marker) VALUES($1,$2,$3)',
      [randomUUID(), freshBusiness, 'fresh']);
    if ((await freshRuntime.query(`SELECT has_table_privilege(current_user,'probe_upgrade_audit','INSERT') AS allowed`)).rows[0].allowed !== true) {
      throw new Error('Fresh V2 runtime grant missing');
    }
    try {
      await freshRuntime.query('INSERT INTO probe_upgrade_audit(id,business_id,marker) VALUES($1,$2,$3)',
        [randomUUID(), randomUUID(), 'orphan']);
      throw new Error('Fresh V2 FK no longer enforces local business reference');
    } catch (error) {
      if (error.code !== '23503') throw error;
    }
    try {
      await freshRuntime.query('INSERT INTO probe_upgrade_audit(id,business_id,marker) VALUES($1,$2,$3)',
        [randomUUID(), freshBusiness, '']);
      throw new Error('Fresh V2 CHECK no longer enforces marker');
    } catch (error) {
      if (error.code !== '23514') throw error;
    }
  } finally { await freshRuntime.end(); }
  console.info('PASS ' + service + ' fresh V1+V2 equals upgrade and runtime DML');

  const failureName = name + '_failure';
  const failureMigration = await database(admin, adminUrl, url, failureName, service);
  const fixture = migrationFixture(root, secretsDir, service, [1, 2]);
  const failureDir = join(fixture.migrations, '202610020003_intentional_failure');
  mkdirSync(failureDir);
  writeFileSync(join(failureDir, 'migration.sql'),
    'BEGIN;\nCREATE TABLE probe_failure_marker(id INTEGER);\nSELECT 1/0;\nCOMMIT;\n');
  deploy(root, fixture.config, failureMigration, 'apply');
  const failureUrl = new URL(adminUrl);
  failureUrl.pathname = '/' + failureName;
  const failureObserver = await pool(failureUrl.toString());
  try {
    const history = await failureObserver.query(`SELECT migration_name,finished_at,rolled_back_at
      FROM _prisma_migrations ORDER BY started_at`);
    if (history.rows.length !== 3 || history.rows[2].migration_name !== '202610020003_intentional_failure' ||
        history.rows[2].finished_at !== null || history.rows[2].rolled_back_at !== null) {
      throw new Error('Failed migration was not recorded');
    }
    if ((await failureObserver.query("SELECT to_regclass('public.probe_failure_marker') AS marker")).rows[0].marker !== null) {
      throw new Error('Failed transactional DDL was not rolled back');
    }
  } finally { await failureObserver.end(); }
  deploy(root, fixture.config, failureMigration, 'blocked'); // Failed ledger blocks pending manual recovery.
  console.info('PASS ' + service + ' isolated migration failure: nonzero deploy, failed ledger, no DDL marker, retry blocked');
}

async function migrationLedger(adminUrl, databaseName) {
  const target = new URL(adminUrl);
  target.pathname = '/' + databaseName;
  const observer = await pool(target.toString());
  try {
    return (await observer.query(`SELECT migration_name,checksum FROM _prisma_migrations
      WHERE finished_at IS NOT NULL ORDER BY migration_name`)).rows;
  } finally { await observer.end(); }
}
