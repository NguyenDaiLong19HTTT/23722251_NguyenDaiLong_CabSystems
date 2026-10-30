import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';

const password=readFileSync(new URL('../../.secrets/customer-dev/payment_runtime_password',
  import.meta.url),'utf8').trim();
const url=new URL('postgresql://payment_runtime@127.0.0.1:55439/cab_payment');
url.password=password;
const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:3000});
try {
  await db.connect();
  const result=await db.query(`SELECT current_user AS role,
    has_database_privilege('payment_runtime','cab_identity','CONNECT') AS identity_access,
    has_database_privilege('payment_runtime','cab_customer','CONNECT') AS customer_access,
    has_schema_privilege('payment_runtime','public','CREATE') AS can_ddl`);
  assert.equal(result.rows[0].role,'payment_runtime');
  assert.equal(result.rows[0].identity_access,false);
  assert.equal(result.rows[0].customer_access,false);
  assert.equal(result.rows[0].can_ddl,false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pricing_config')).rows[0].n,1);
  await assert.rejects(()=>db.query('CREATE TABLE payment_runtime_must_not_create(id int)'),
    error=>error?.code==='42501');
  console.info('PASS cab_payment runtime role: read tariff, no DDL, no Identity/Customer DB CONNECT.');
} finally {await db.end().catch(()=>undefined);}
