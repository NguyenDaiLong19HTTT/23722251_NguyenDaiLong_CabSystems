// Technical experiment only. No existing resource is selected as a DB target.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runUpgrade } from './upgrade.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = randomUUID();
const project = 'cab-prisma-probe-' + id;
const secretsRoot = join(root, '.secrets');
mkdirSync(secretsRoot, { recursive: true });
const secretsDir = join(secretsRoot, project);
mkdirSync(secretsDir); // exclusive fresh directory
const passwords = Object.fromEntries(['postgres', 'identity_migration', 'identity_runtime',
  'customer_migration', 'customer_runtime'].map(name => [name, randomBytes(32).toString('base64url')]));
writeFileSync(join(secretsDir, 'postgres_password'), passwords.postgres, { flag: 'wx' });
const redact = text => {
  let safe = String(text);
  for (const secret of Object.values(passwords)) safe = safe.replaceAll(secret, '[REDACTED]');
  return safe;
};
const docker = process.env.CAB_PROBE_DOCKER ?? 'docker';
const composeArgs = ['compose', '--project-name', project, '--file',
  join(root, 'experiments/prisma-postgres/compose.yaml'), '--profile', 'test'];
const environment = { ...process.env, CAB_PROBE_SECRET_DIR: secretsDir };
function command(executable, args, env = environment, timeout = 120000) {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0) throw new Error('Probe command failed: ' + args[0]);
  return result.stdout.trim();
}
const inspect = args => execFileSync(docker, args, { env: environment, encoding: 'utf8', timeout: 15000 }).trim();
let started = false;
let admin;
let resultCode = 1;
try {
  if (inspect(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project])) {
    throw new Error('Fresh experiment project unexpectedly exists');
  }
  console.info('Starting isolated project ' + project + '; tmpfs, no persistent volume');
  started = true; // cleanup partial starts too, only after fresh-project check
  command(docker, [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '60']);
  const container = inspect([...composeArgs, 'ps', '-q', 'postgres']);
  if (!container || inspect(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]) !== project) {
    throw new Error('Experiment ownership check failed');
  }
  const mapping = inspect(['port', container, '5432/tcp']);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
  if (!match) throw new Error('Experiment must publish loopback only');
  const port = match[1];
  const url = (user, database) => 'postgresql://' + user + ':' + passwords[user] + '@127.0.0.1:' + port + '/' + database;
  const adminUrl = url('postgres', 'postgres');
  admin = new pg.Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5000 });
  const version = (await admin.query('SHOW server_version')).rows[0].server_version;
  if (!version.startsWith('17.11')) throw new Error('Unexpected PostgreSQL version');
  console.info('PASS isolated PostgreSQL ' + version + '; project ' + project);
  await admin.query('REVOKE ALL ON DATABASE postgres FROM PUBLIC');
  await admin.query('REVOKE ALL ON DATABASE template1 FROM PUBLIC');
  const env = { ...environment, CAB_PROBE_ADMIN_URL: adminUrl };
  for (const service of ['identity', 'customer']) {
    for (const kind of ['migration', 'runtime']) {
      const role = service + '_' + kind;
      // Only fixed role identifiers and freshly generated base64url passwords.
      await admin.query("CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '" + passwords[role] + "'");
    }
    const database = 'cab_' + service;
    await admin.query('CREATE DATABASE ' + database + ' OWNER ' + service + '_migration');
    await admin.query('REVOKE ALL ON DATABASE ' + database + ' FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE ' + database + ' TO ' + service + '_runtime');
    const connection = new pg.Client({ connectionString: url('postgres', database) });
    await connection.connect();
    try {
      await connection.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await connection.query('GRANT USAGE ON SCHEMA public TO ' + service + '_runtime');
      const tables = await connection.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
      if (tables.rows[0].n !== 0) throw new Error('Migration target is not empty');
      console.info('PASS empty migration target ' + database + '; separate migration/runtime roles');
    } finally { await connection.end(); }
    const prefix = 'CAB_PROBE_' + service.toUpperCase();
    env[prefix + '_URL'] = url(service + '_runtime', database);
    env[prefix + '_MIGRATION_URL'] = url(service + '_migration', database);
    const config = 'services/' + service + '-service/src/infrastructure/prisma-probe/prisma.config.ts';
    command(process.execPath, ['node_modules/prisma/build/index.js', 'generate', '--config', config],
      { ...env, CAB_PROBE_MIGRATION_URL: env[prefix + '_MIGRATION_URL'] });
  }
  for (const service of ['identity', 'customer']) {
    await runUpgrade(root, secretsDir, admin, adminUrl, url, service);
  }
  command(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.probe.json'], env);
  command(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
    'experiments/prisma-postgres/vitest.config.ts', '--reporter=verbose'], env);
  resultCode = 0;
} catch (error) {
  console.error(redact('Probe failed: ' + error.message));
} finally {
  if (admin) await admin.end();
  try {
    if (started) {
      const containers = inspect(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).split(/\r?\n/).filter(Boolean);
      for (const container of containers) {
        if (inspect(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]) !== project) {
          throw new Error('Refusing cleanup of unowned container');
        }
      }
      command(docker, [...composeArgs, 'down', '--timeout', '5']); // no -v, only fresh project
      if (inspect(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project])) throw new Error('Owned container remains');
      console.info('PASS cleanup owned project; no user resource or volume removed');
    }
    const absolute = realpathSync(secretsDir);
    if (dirname(absolute) !== realpathSync(secretsRoot) || absolute !== realpathSync(join(secretsRoot, project))) {
      throw new Error('Refusing cleanup outside owned experiment secret directory');
    }
    rmSync(absolute, { recursive: true });
  } catch (error) {
    console.error(redact('Cleanup failed: ' + error.message));
    resultCode = 1;
  }
}
process.exitCode = resultCode;
