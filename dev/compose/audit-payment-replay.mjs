// Run with docker compose exec -T payment-service node - ; read-only counts.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
const paymentId=process.env.CAB_TEST_PAYMENT_ID;
assert.match(paymentId??'',/^[0-9a-f-]{36}$/i);
const url=new URL('postgresql://localhost/cab_payment');
url.hostname='postgres';url.port='5432';url.username='payment_runtime';
url.password=readFileSync('/cab-runtime/payment_runtime_password','utf8').trim();
const client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:2500});
try {
  await client.connect();
  const result=await client.query(`SELECT
    (SELECT count(*)::int FROM fare WHERE trip_id=p.trip_id) AS fares,
    (SELECT count(*)::int FROM payment WHERE trip_id=p.trip_id) AS payments,
    (SELECT count(*)::int FROM payment_attempt WHERE payment_id=p.payment_id) AS attempts,
    (SELECT count(*)::int FROM payment_receipt WHERE resource_id IN
      (p.trip_id,p.payment_id)) AS receipts,
    (SELECT count(*)::int FROM payment_outbox WHERE payment_id=p.payment_id
      AND event_type='PAYMENT_SUCCESS') AS success_events,
    (SELECT count(*)::int FROM payment_outbox WHERE payment_id=p.payment_id
      AND event_type='PAYMENT_FAILED') AS failed_events
    FROM payment p WHERE payment_id=$1`,[paymentId]);
  assert.equal(result.rows.length,1);
  const counts=result.rows[0];
  assert.deepEqual([counts.fares,counts.payments,counts.attempts,
    counts.receipts,counts.success_events,counts.failed_events],[1,1,1,2,1,0]);
  console.info(JSON.stringify(counts));
} finally {await client.end().catch(()=>undefined);}
