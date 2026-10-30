// Isolated production-schema verification; owns only a fresh Compose project and tmpfs.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { names, verifyUpgrade } from './upgrade.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const project = 'cab-production-schema-' + randomUUID();
const secretsRoot = join(root, '.secrets');
mkdirSync(secretsRoot, { recursive: true });
const secretsDir = join(secretsRoot, project);
mkdirSync(secretsDir);
const roles = ['postgres','identity_migration','identity_runtime','customer_migration','customer_runtime'];
const passwords = Object.fromEntries(roles.map(role => [role, randomBytes(32).toString('base64url')]));
writeFileSync(join(secretsDir, 'postgres_password'), passwords.postgres, { flag: 'wx' });
const safe = value => Object.values(passwords).reduce((s, secret) => String(s).replaceAll(secret, '[REDACTED]'), String(value));
const docker = process.env.CAB_PROBE_DOCKER ?? 'docker';
const compose = ['compose','--project-name',project,'--file',
  join(root,'experiments/prisma-postgres/compose.yaml'),'--profile','test'];
const baseEnv = { ...process.env, CAB_PROBE_SECRET_DIR: secretsDir };
function command(exe, args, env = baseEnv, timeout = 120000) {
  const r = spawnSync(exe, args, { cwd: root, env, encoding: 'utf8', timeout,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (r.stdout) process.stdout.write(safe(r.stdout));
  if (r.stderr) process.stderr.write(safe(r.stderr));
  if (r.error || r.status !== 0) throw new Error('Production-schema command failed: ' + args[0]);
  return r.stdout.trim();
}
function inspect(args) {
  return execFileSync(docker, args, { env: baseEnv, encoding: 'utf8', timeout: 15000 }).trim();
}
let started = false;
let admin;
let exitCode = 1;
try {
  if (inspect(['ps','-aq','--filter','label=com.docker.compose.project=' + project]))
    throw new Error('Fresh project unexpectedly exists');
  started = true;
  command(docker, [...compose,'up','-d','--wait','--wait-timeout','60']);
  const container = inspect([...compose,'ps','-q','postgres']);
  if (!container || inspect(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',container]) !== project)
    throw new Error('Experiment ownership check failed');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(inspect(['port',container,'5432/tcp']));
  if (!match) throw new Error('Experiment must bind loopback only');
  const url = (role, database) => `postgresql://${role}:${passwords[role]}@127.0.0.1:${match[1]}/${database}`;
  admin = new pg.Pool({ connectionString: url('postgres','postgres'), max: 1,
    connectionTimeoutMillis: 5000 });
  const version = (await admin.query('SHOW server_version')).rows[0].server_version;
  if (!version.startsWith('17.11')) throw new Error('Unexpected PostgreSQL version');
  await admin.query('REVOKE ALL ON DATABASE postgres FROM PUBLIC');
  await admin.query('REVOKE ALL ON DATABASE template1 FROM PUBLIC');
  const env = { ...baseEnv, CAB_PRODUCTION_ADMIN_URL: url('postgres','postgres') };
  for (const service of ['identity','customer']) {
    for (const kind of ['migration','runtime']) {
      const role = service + '_' + kind;
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${passwords[role]}'`);
    }
    const database = 'cab_' + service;
    await admin.query(`CREATE DATABASE ${database} OWNER ${service}_migration`);
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${service}_runtime`);
    const local = new pg.Client({ connectionString: url('postgres',database) });
    await local.connect();
    try {
      await local.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await local.query(`GRANT USAGE ON SCHEMA public TO ${service}_runtime`);
      const tables = await local.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'");
      if (tables.rows[0].n !== 0) throw new Error('Migration target is not empty');
    } finally { await local.end(); }
    env['CAB_' + service.toUpperCase() + '_RUNTIME_URL'] = url(service + '_runtime',database);
    env['CAB_' + service.toUpperCase() + '_MIGRATION_URL'] = url(service + '_migration',database);
    const config = `services/${service}-service/src/infrastructure/prisma/prisma.config.ts`;
    command(process.execPath,['node_modules/prisma/build/index.js','generate','--config',config],env);
    command(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--config',config],env);
  }
  await verifyUpgrade({ root, secretsDir, admin, url, command, baseEnv: env });
  command(process.execPath,['node_modules/vitest/vitest.mjs','run','--config',
    'experiments/production-postgres/vitest.config.ts','--reporter=verbose'],env);
  const baseline = {};
  for (const service of ['identity','customer']) {
    const connection = new pg.Client({ connectionString: url('postgres','cab_' + service) });
    await connection.connect();
    try {
      const table = service === 'identity' ? 'account' : 'customer_provision';
      const ledger = await connection.query('SELECT migration_name,checksum,finished_at FROM _prisma_migrations ORDER BY migration_name');
      const rows = await connection.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.deepEqual(ledger.rows.map(row=>row.migration_name),names[service]);
      assert.ok(rows.rows[0].n > 0);
      baseline[service] = { ledger: ledger.rows, rows: rows.rows[0].n };
    } finally { await connection.end(); }
  }
  for (const service of ['identity','customer']) {
    const config = `services/${service}-service/src/infrastructure/prisma/prisma.config.ts`;
    command(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--config',config],env);
    const connection = new pg.Client({ connectionString: url('postgres','cab_' + service) });
    await connection.connect();
    try {
      const table = service === 'identity' ? 'account' : 'customer_provision';
      const ledger = await connection.query('SELECT migration_name,checksum,finished_at FROM _prisma_migrations ORDER BY migration_name');
      const rows = await connection.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.deepEqual(ledger.rows, baseline[service].ledger);
      assert.equal(rows.rows[0].n, baseline[service].rows);
    } finally { await connection.end(); }
  }
  console.info('PASS production-schema fresh deploy, integration suite and deploy replay');
  exitCode = 0;
} catch (error) {
  console.error(safe('Production-schema verification failed: ' + error.message));
} finally {
  if (admin) await admin.end();
  try {
    if (started) {
      const containers = inspect(['ps','-aq','--filter','label=com.docker.compose.project=' + project]).split(/\r?\n/).filter(Boolean);
      for (const id of containers) {
        if (inspect(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id]) !== project)
          throw new Error('Refusing cleanup of unowned container');
      }
      command(docker,[...compose,'down','--timeout','5']);
      if (inspect(['ps','-aq','--filter','label=com.docker.compose.project=' + project]))
        throw new Error('Owned container remains');
    }
    const absolute = realpathSync(secretsDir);
    if (dirname(absolute) !== realpathSync(secretsRoot) || absolute !== realpathSync(join(secretsRoot,project)))
      throw new Error('Refusing cleanup outside owned secret directory');
    rmSync(absolute,{recursive:true});
  } catch (error) {
    console.error(safe('Owned cleanup failed: ' + error.message));
    exitCode = 1;
  }
}
process.exitCode = exitCode;
