// Pipe into the running Trip container; read-only, synthetic Trip ID in env.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';

const tripId=process.env.CAB_TEST_TRIP_ID;
assert.match(tripId??'',/^[0-9a-f-]{36}$/i);
const url=new URL('postgresql://localhost/');
url.hostname='postgres';url.port='5432';url.pathname='/cab_trip';url.username='trip_runtime';
url.password=readFileSync('/cab-runtime/trip_runtime_password','utf8').trim();
const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:3000});
try {
  await db.connect();
  const result=await db.query(`SELECT
    (SELECT count(*)::int FROM trip WHERE trip_id=$1 AND status='ERROR'
      AND closed_at IS NOT NULL AND close_reason IS NOT NULL) AS closed,
    (SELECT count(*)::int FROM trip_incident WHERE trip_id=$1 AND status='RESOLVED') AS incidents,
    (SELECT count(*)::int FROM trip_resolution_audit WHERE trip_id=$1) AS audits,
    (SELECT count(*)::int FROM trip_receipt WHERE trip_id=$1 AND operation='RESOLVE') AS receipts,
    (SELECT count(*)::int FROM trip_outbox WHERE trip_id=$1
      AND event_type='TRIP_RECOVERED') AS recovered_events,
    (SELECT count(*)::int FROM trip_outbox WHERE trip_id=$1
      AND event_type='TRIP_CLOSED_ABNORMALLY') AS closed_events,
    (SELECT count(*)::int FROM trip_closure WHERE trip_id=$1
      AND driver_release='CONFIRMED' AND customer_release='CONFIRMED'
      AND payment_fence='CONFIRMED') AS closures`,[tripId]);
  const evidence=result.rows[0];
  assert.deepEqual(evidence,{closed:1,incidents:2,audits:2,receipts:2,
    recovered_events:1,closed_events:1,closures:1});
  console.info('PASS Trip ERROR DB audit:',JSON.stringify(evidence));
} finally {await db.end().catch(()=>undefined);}
