// One-time additive setup for cab_trip; never rewrites existing CAB databases.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import pg from 'pg';

const folder=new URL('../../.secrets/customer-dev/',import.meta.url);
const local=name=>new URL(name,folder);
if(!existsSync(local('postgres_password'))) throw new Error('Existing CAB PostgreSQL setup missing');
for(const name of ['trip_migration_password','trip_runtime_password','rabbit_trip_password',
  'trip_cursor_key']) if(!existsSync(local(name)))
  writeFileSync(local(name),randomBytes(32).toString('base64url'),{flag:'wx',mode:0o600});
const secret=name=>readFileSync(local(name),'utf8').trim();
const url=new URL('postgresql://postgres@127.0.0.1:55439/postgres');
url.password=secret('postgres_password');
const admin=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
try {
  await admin.connect();
  const found=await admin.query(`SELECT
    EXISTS(SELECT 1 FROM pg_database WHERE datname='cab_trip') AS db,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='trip_migration') AS migration,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='trip_runtime') AS runtime`);
  if(found.rows[0]?.db||found.rows[0]?.migration||found.rows[0]?.runtime)
    throw new Error('Trip database/roles already exist; inspect ownership before rerun');
  for(const suffix of ['migration','runtime']) {
    const role=`trip_${suffix}`;
    const formatted=await admin.query(
      `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
        $1::text,$2::text) AS sql`,[role,secret(role+'_password')]);
    await admin.query(formatted.rows[0].sql);
  }
  await admin.query('CREATE DATABASE cab_trip OWNER trip_migration');
  await admin.query('REVOKE ALL ON DATABASE cab_trip FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE cab_trip TO trip_runtime');
  const localDbUrl=new URL(url);localDbUrl.pathname='/cab_trip';
  const localDb=new pg.Client({connectionString:localDbUrl.toString(),connectionTimeoutMillis:5000});
  try {await localDb.connect();await localDb.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await localDb.query('GRANT USAGE ON SCHEMA public TO trip_runtime');}
  finally {await localDb.end().catch(()=>undefined);}
  console.info('Trip database and isolated migration/runtime roles created.');
} catch {
  console.error('Trip setup stopped; inspect cab_trip and roles before retry.');
  process.exitCode=1;
} finally {await admin.end().catch(()=>undefined);}
