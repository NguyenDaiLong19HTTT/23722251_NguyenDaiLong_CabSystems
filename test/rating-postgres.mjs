// Disposable PostgreSQL only; no user/demo database is touched.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {RatingLedger} from '../services/rating-service/dist/application/rating-ledger.js';
import {normalizeRating} from '../services/rating-service/dist/domain/rating.js';

const temp=mkdtempSync(join(tmpdir(),'cab-rating-check-'));
const name=`cab-rating-check-${process.pid}-${randomBytes(4).toString('hex')}`;
const adminPassword=randomBytes(32).toString('base64url');
const runtimePassword=randomBytes(32).toString('base64url');
const secretFile=join(temp,'postgres-password');
writeFileSync(secretFile,adminPassword,{mode:0o600});
const docker=args=>{const result=spawnSync('docker',args,{encoding:'utf8',timeout:120000});
  if(result.status!==0) throw new Error(`Disposable Rating PostgreSQL command failed: ${args[0]}`);
  return result.stdout.trim();};
const wait=async()=>{for(let i=0;i<60;i++) {
  const result=spawnSync('docker',['exec',name,'pg_isready','-U','postgres','-d','cab_rating'],
    {encoding:'utf8',timeout:5000});if(result.status===0) return;
  await new Promise(resolve=>setTimeout(resolve,500));
} throw new Error('Disposable Rating PostgreSQL readiness timeout');};
let started=false,admin,runtime;
try {
  docker(['run','-d','--rm','--name',name,
    '--mount',`type=bind,source=${secretFile},target=/run/secrets/cab_pw,readonly`,
    '-e','POSTGRES_PASSWORD_FILE=/run/secrets/cab_pw','-e','POSTGRES_DB=cab_rating',
    '-p','127.0.0.1::5432',
    'postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652']);
  started=true;await wait();
  const port=Number(docker(['port',name,'5432/tcp']).split(/\r?\n/)
    .find(line=>line.startsWith('127.0.0.1:'))?.match(/:(\d+)$/)?.[1]);
  assert.ok(Number.isSafeInteger(port)&&port>0);
  const url=new URL(`postgresql://postgres@127.0.0.1:${port}/cab_rating`);
  url.password=adminPassword;
  admin=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});
  let ready=false;for(let i=0;i<40;i++) {try {await admin.query('SELECT 1');ready=true;break;}
    catch {await new Promise(resolve=>setTimeout(resolve,250));}}
  assert.ok(ready,'disposable Rating host port ready');
  const role=await admin.query(`SELECT format(
    'CREATE ROLE rating_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
    $1::text) AS sql`,[runtimePassword]);
  await admin.query(role.rows[0].sql);
  await admin.query('REVOKE ALL ON DATABASE cab_rating FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE cab_rating TO rating_runtime');
  await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await admin.query('GRANT USAGE ON SCHEMA public TO rating_runtime');
  await admin.query(readFileSync(new URL('../services/rating-service/src/infrastructure/migrations/202610120001_rating.sql',
    import.meta.url),'utf8'));
  const runtimeUrl=new URL(url);runtimeUrl.username='rating_runtime';
  runtimeUrl.password=runtimePassword;
  runtime=new pg.Pool({connectionString:runtimeUrl.toString(),max:4,connectionTimeoutMillis:5000});
  assert.equal((await runtime.query('SELECT 1 AS ok')).rows[0].ok,1);
  await assert.rejects(()=>runtime.query('CREATE TABLE forbidden_rating_ddl(id INT)'),
    error=>error?.code==='42501');
  for(const score of [0,6,1.5,'5',true,null])
    assert.throws(()=>normalizeRating(score,undefined),/VALIDATION_ERROR/);
  assert.equal(normalizeRating(5,'  good ride  ').comment,'good ride');
  assert.equal(normalizeRating(4,'   ').comment,null);
  for(const comment of [null,42,'x'.repeat(1001)])
    assert.throws(()=>normalizeRating(3,comment),/VALIDATION_ERROR/);
  assert.equal(normalizeRating(3,'x'.repeat(1000)).comment?.length,1000);
  const ledger=new RatingLedger(runtime,randomBytes(32));
  const context={tripId:randomUUID(),customerId:randomUUID(),driverId:randomUUID(),
    tripVersion:'5',verifiedAt:new Date()};
  const first=await ledger.create(context,{score:5,comment:'good ride'},randomUUID());
  const replay=await ledger.create(context,{score:5,comment:'good ride'},randomUUID());
  assert.deepEqual(replay,first,'same normalized payload replays immutable Rating');
  assert.deepEqual(await ledger.get(context.tripId),first);
  await assert.rejects(()=>ledger.create(context,{score:4,comment:'good ride'},randomUUID()),
    error=>error?.details==='RATING_ALREADY_EXISTS');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM rating_audit')).rows[0].n,1);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM rating_receipt')).rows[0].n,2);
  const parallel={...context,tripId:randomUUID()};
  const results=await Promise.allSettled([
    ledger.create(parallel,{score:3,comment:null},randomUUID()),
    ledger.create(parallel,{score:4,comment:null},randomUUID())]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(results.filter(item=>item.status==='rejected'&&
    item.reason?.details==='RATING_ALREADY_EXISTS').length,1);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM rating WHERE trip_id=$1',
    [parallel.tripId])).rows[0].n,1);
  const rollback={...context,tripId:randomUUID()};
  await admin.query(`ALTER TABLE rating_audit ADD CONSTRAINT test_audit_failure
    CHECK (trip_id <> '${rollback.tripId}'::uuid)`);
  await assert.rejects(()=>ledger.create(rollback,{score:2,comment:null},randomUUID()),
    error=>error?.code==='23514');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM rating WHERE trip_id=$1',
    [rollback.tripId])).rows[0].n,0,'audit failure rolls back Rating');
  console.info('PASS disposable Rating PostgreSQL: validation, runtime DDL denial, replay/conflict, concurrent unique, audit once and rollback');
} finally {
  await runtime?.end().catch(()=>undefined);await admin?.end().catch(()=>undefined);
  if(started) spawnSync('docker',['stop',name],{encoding:'utf8',timeout:20000});
  rmSync(temp,{recursive:true,force:true});
}
