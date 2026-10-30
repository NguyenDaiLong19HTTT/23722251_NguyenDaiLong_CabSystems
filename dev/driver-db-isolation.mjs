import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root=fileURLToPath(new URL('../',import.meta.url)),folder=join(root,'.secrets','customer-dev');
const password=readFileSync(join(folder,'driver_runtime_password'),'utf8').trim();
const client=name=>new pg.Client({connectionString:`postgresql://driver_runtime:${password}@127.0.0.1:55439/${name}`,
  connectionTimeoutMillis:3000});
const owned=client('cab_driver');await owned.connect();
try {
  const result=await owned.query('SELECT count(*)::int AS n FROM driver_profile');
  assert.equal(result.rows[0].n,1);
  await assert.rejects(owned.query('CREATE TABLE driver_runtime_must_not_ddl(id int)'),
    error=>error.code==='42501');
} finally {await owned.end();}
for (const database of ['cab_identity','cab_customer']) {
  const other=client(database);
  await assert.rejects(other.connect(),error=>error.code==='42501');
  await other.end().catch(()=>undefined);
}
console.info('PASS driver_runtime DML/own DB, DDL deny and cross-service DB deny');
