// One-time additive setup for cab_payment only; preserves existing databases and credentials.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import pg from 'pg';

const folder=new URL('../../.secrets/customer-dev/',import.meta.url);
const local=name=>new URL(name,folder);
if (!existsSync(local('postgres_password')))
  throw new Error('Existing CAB PostgreSQL setup missing');
const writeOnce=name=>{
  const file=local(name);
  if (!existsSync(file)) writeFileSync(file,randomBytes(32).toString('base64url'),
    {flag:'wx',mode:0o600});
};
writeOnce('payment_migration_password');writeOnce('payment_runtime_password');
writeOnce('rabbit_payment_password');
writeOnce('payment_cursor_key');
const secret=name=>readFileSync(local(name),'utf8').trim();
const adminUrl=new URL('postgresql://postgres@127.0.0.1:55439/postgres');
adminUrl.password=secret('postgres_password');
const admin=new pg.Client({connectionString:adminUrl.toString(),connectionTimeoutMillis:5000});
try {
  await admin.connect();
  const database=await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',['cab_payment']);
  const migration=await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',['payment_migration']);
  const runtime=await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',['payment_runtime']);
  if (database.rowCount||migration.rowCount||runtime.rowCount)
    throw new Error('Payment database/roles already exist; inspect ownership before rerun');
  for (const suffix of ['migration','runtime']) {
    const role=`payment_${suffix}`;
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT PASSWORD '${secret(role+'_password')}'`);
  }
  await admin.query('CREATE DATABASE cab_payment OWNER payment_migration');
  await admin.query('REVOKE ALL ON DATABASE cab_payment FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE cab_payment TO payment_runtime');
  const localDbUrl=new URL(adminUrl);localDbUrl.pathname='/cab_payment';
  const localDb=new pg.Client({connectionString:localDbUrl.toString(),connectionTimeoutMillis:5000});
  try {await localDb.connect();await localDb.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await localDb.query('GRANT USAGE ON SCHEMA public TO payment_runtime');}
  finally {await localDb.end().catch(()=>undefined);}
  console.info('Payment database and separate migration/runtime roles created.');
} catch(error) {
  console.error('Payment setup stopped; inspect cab_payment and role state before retry.');
  throw new Error('Payment setup incomplete');
} finally {await admin.end().catch(()=>undefined);}
