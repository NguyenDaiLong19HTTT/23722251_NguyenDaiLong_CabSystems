import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const local=join(root,'.secrets','customer-dev');
const fixture=JSON.parse(readFileSync(join(local,'driver_registration_race_smoke.json'),'utf8'));
const url=new URL('postgresql://driver_runtime@127.0.0.1:55439/cab_driver');
url.password=readFileSync(join(local,'driver_runtime_password'),'utf8').trim();
const db=new pg.Client({connectionString:url.toString()});
try {
  await db.connect();
  let result;
  for(let attempt=0;attempt<30;attempt++) {
    result=await db.query(`SELECT a.status,o.event_type,o.published_at
    FROM driver_application a LEFT JOIN driver_application_outbox o
      ON o.application_id=a.application_id AND o.event_type IN
      ('DRIVER_APPLICATION_APPROVED','DRIVER_APPLICATION_REJECTED')
    WHERE a.application_id=$1::uuid`,[fixture.applicationId]);
    if(result.rows[0]?.published_at) break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.equal(result.rowCount,1,'losing review must not commit outbox event');
  const row=result.rows[0];
  assert.equal(row.event_type,`DRIVER_APPLICATION_${row.status}`);
  assert.ok(row.published_at,'winning review outbox eventually published');
  console.info('PASS Driver review atomicity: one committed outcome, one matching published outbox event');
} finally {await db.end().catch(()=>undefined);}
