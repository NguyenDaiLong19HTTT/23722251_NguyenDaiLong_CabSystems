// One-time additive Rating database setup; never resets an existing database.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import pg from 'pg';

const folder=new URL('../../.secrets/customer-dev/',import.meta.url);
const local=name=>new URL(name,folder);
if(!existsSync(local('postgres_password'))) throw new Error('Existing CAB PostgreSQL setup missing');
for(const name of ['rating_migration_password','rating_runtime_password','rating_cursor_key'])
  if(!existsSync(local(name))) writeFileSync(local(name),randomBytes(32).toString('base64url'),
    {flag:'wx',mode:0o600});
const secret=name=>readFileSync(local(name),'utf8').trim();
const url=new URL('postgresql://postgres@127.0.0.1:55439/postgres');
url.password=secret('postgres_password');
const admin=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
try {
  await admin.connect();
  const found=await admin.query(`SELECT
    EXISTS(SELECT 1 FROM pg_database WHERE datname='cab_rating') AS db,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rating_migration') AS migration,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rating_runtime') AS runtime`);
  if(found.rows[0]?.db||found.rows[0]?.migration||found.rows[0]?.runtime)
    throw new Error('Rating database/roles already exist; inspect ownership before rerun');
  for(const suffix of ['migration','runtime']) {
    const role=`rating_${suffix}`;
    const formatted=await admin.query(
      `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
        $1::text,$2::text) AS sql`,[role,secret(role+'_password')]);
    await admin.query(formatted.rows[0].sql);
  }
  await admin.query('CREATE DATABASE cab_rating OWNER rating_migration');
  await admin.query('REVOKE ALL ON DATABASE cab_rating FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE cab_rating TO rating_runtime');
  const localDbUrl=new URL(url);localDbUrl.pathname='/cab_rating';
  const db=new pg.Client({connectionString:localDbUrl.toString(),connectionTimeoutMillis:5000});
  try {await db.connect();await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA public TO rating_runtime');}
  finally {await db.end().catch(()=>undefined);}
  console.info('Rating database and isolated migration/runtime roles created.');
} catch {
  console.error('Rating setup stopped; inspect cab_rating and roles before retry.');
  process.exitCode=1;
} finally {await admin.end().catch(()=>undefined);}
