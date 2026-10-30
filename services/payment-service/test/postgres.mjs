// Isolated PostgreSQL integration harness. The caller supplies a disposable DB URL.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {PricingCapture} from '../dist/application/pricing-capture.js';
import {PaymentLedger} from '../dist/application/payment-ledger.js';
import {fareVnd,fareForPriceVnd} from '../dist/domain/pricing.js';

const raw=process.env.CAB_PAYMENT_TEST_URL;
if (!raw) throw new Error('Disposable Payment test URL required');
const admin=new pg.Pool({connectionString:raw,max:4});
const runtimeUrl=new URL(raw);runtimeUrl.username='payment_runtime';
const runtime=new pg.Pool({connectionString:runtimeUrl.toString(),max:4});
const price=new PricingCapture(runtime),ledger=new PaymentLedger(runtime,randomBytes(32));
const request=(operation_id,overrides={})=>({operation_id,vehicle_type:'MOTORBIKE',
  booking_accepted_at:{seconds:String(Math.floor(Date.now()/1000)),nanos:0},
  pickup:{point:{latitude:10.7769,longitude:106.7009},address:'Demo A'},
  destination:{point:{latitude:10.7869,longitude:106.7109},address:'Demo B'},
  ...overrides});
const rejected=async(work,reason)=>{
  await assert.rejects(work,error=>error?.details===reason,reason);
};
try {
  assert.equal(fareVnd(5n),27n); // 26.5 VND rounds once, half up.
  assert.equal(fareVnd(1250n),6625n);
  assert.equal(fareForPriceVnd(5n,'5300.000000'),27n);
  assert.equal(fareForPriceVnd(1250n,'5300.000000'),6625n);
  const op=randomUUID(),input=request(op);
  const first=await price.get(input);
  assert.equal(first.vehicle_type,'MOTORBIKE');
  assert.equal(first.distance_meters,'1250');
  assert.equal(first.total_amount,'6625');
  const replay=await price.get(input);assert.deepEqual(replay,first);
  await rejected(()=>price.get(request(op,{vehicle_type:'STANDARD'})),'PRICING_CAPTURE_CONFLICT');
  await rejected(()=>price.get(request(randomUUID(),{vehicle_type:'STANDARD'})),'VALIDATION_ERROR');
  await rejected(()=>price.get(request(op,{destination:{point:{latitude:10.7868,longitude:106.7109}}})),
    'PRICING_CAPTURE_CONFLICT');
  await rejected(()=>price.get({...input,booking_accepted_at:{
    ...input.booking_accepted_at,nanos:1}}),'PRICING_CAPTURE_CONFLICT');
  await rejected(()=>price.get({...input,pickup:{...input.pickup,address:'Other label'}}),
    'PRICING_CAPTURE_CONFLICT');
  await rejected(()=>price.get(request(randomUUID(),{pickup:{point:{latitude:1,longitude:1}}})),
    'ROUTE_UNSUPPORTED');
  await admin.query(`UPDATE demo_route SET distance_meters=1300 WHERE route_id=$1`,[first.route_id]);
  assert.deepEqual(await price.get(input),first);
  const newPrice=await price.get(request(randomUUID()));
  assert.equal(newPrice.total_amount,'6890');
  // Synthetic verified owner context: exercises Payment DB invariants, not Booking/Trip RPC.
  const ctx={tripId:randomUUID(),bookingId:randomUUID(),customerId:randomUUID(),
    driverId:randomUUID(),customerAccountId:randomUUID(),driverAccountId:randomUUID(),
    pricingVersionId:first.pricing_version_id,
    routeId:first.route_id,routeVersion:'1',distanceMeters:'1250',amountVnd:'6625',
    pricingSnapshot:first};
  const accountId=ctx.customerAccountId,key='payment-create-1';
  const [a,b]=await Promise.all([ledger.create(ctx,accountId,key,'DEMO_TRANSFER'),
    ledger.create(ctx,accountId,key,'DEMO_TRANSFER')]);
  assert.deepEqual(a,b);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM payment WHERE trip_id=$1',
    [ctx.tripId])).rows[0].n,1);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM payment_attempt WHERE payment_id=$1',
    [a.payment_id])).rows[0].n,1);
  assert.equal((await ledger.tripStartDecision(ctx.tripId)).can_start_trip,false);
  await rejected(()=>ledger.create(ctx,accountId,key,'CASH'),'IDEMPOTENCY_CONFLICT');
  await rejected(()=>ledger.create(ctx,accountId,'another-key','DEMO_TRANSFER'),'PAYMENT_ALREADY_EXISTS');
  await rejected(()=>ledger.create(ctx,randomUUID(),'foreign-account','DEMO_TRANSFER'),'FORBIDDEN');
  await rejected(()=>ledger.result(a.payment_id,ctx.customerId,accountId,a.current_attempt_id,
    'result-1','1','6624','VND',
    'SUCCESS',true),'PAYMENT_AMOUNT_MISMATCH');
  await rejected(()=>ledger.result(a.payment_id,ctx.customerId,accountId,a.current_attempt_id,
    'result-1','1','6625','VND',
    'SUCCESS',false),'FORBIDDEN');
  const paid=await ledger.result(a.payment_id,ctx.customerId,accountId,a.current_attempt_id,
    'result-1','1','6625','VND',
    'SUCCESS',true);
  assert.equal(paid.payment_status,'PAYMENT_SUCCESS');
  assert.equal((await ledger.tripStartDecision(ctx.tripId)).can_start_trip,true);
  assert.deepEqual(await ledger.result(a.payment_id,ctx.customerId,accountId,a.current_attempt_id,
    'result-1','1','6625',
    'VND','SUCCESS',true),paid);
  await rejected(()=>ledger.result(a.payment_id,ctx.customerId,accountId,a.current_attempt_id,
    'result-2','2','6625','VND',
    'FAILED',true),'PAYMENT_NOT_PENDING');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM payment_outbox WHERE payment_id=$1',
    [a.payment_id])).rows[0].n,1);
  const cancelled=await ledger.recordTripCancellation(ctx.tripId,randomUUID());
  assert.equal(cancelled.review_recorded,true);
  assert.equal((await ledger.find(a.payment_id)).status,'SUCCESS');
  assert.equal((await ledger.find(a.payment_id)).requires_review,true);
  assert.equal((await ledger.tripStartDecision(ctx.tripId)).can_start_trip,false);
  assert.deepEqual(await ledger.recordTripCancellation(ctx.tripId,cancelled.cancellation_id),cancelled);
  await rejected(()=>ledger.recordTripCancellation(ctx.tripId,randomUUID()),
    'TRIP_CANCELLATION_CONFLICT');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM payment_outbox WHERE payment_id=$1',
    [a.payment_id])).rows[0].n,2);
  const beforeCtx={...ctx,tripId:randomUUID(),bookingId:randomUUID()};
  await ledger.recordTripCancellation(beforeCtx.tripId,randomUUID());
  await rejected(()=>ledger.create(beforeCtx,accountId,'after-cancel','DEMO_TRANSFER'),
    'TRIP_CANCELLED');
  const pendingCtx={...ctx,tripId:randomUUID(),bookingId:randomUUID()};
  const pending=await ledger.create(pendingCtx,accountId,'pending-create','DEMO_TRANSFER');
  await ledger.recordTripCancellation(pendingCtx.tripId,randomUUID());
  await rejected(()=>ledger.result(pending.payment_id,pendingCtx.customerId,accountId,
    pending.current_attempt_id,'pending-result','1','6625','VND','SUCCESS',true),
    'TRIP_CANCELLED');
  const failedCtx={...ctx,tripId:randomUUID(),bookingId:randomUUID()};
  const failed=await ledger.create(failedCtx,accountId,'failed-create','DEMO_TRANSFER');
  const firstFailure=await ledger.result(failed.payment_id,failedCtx.customerId,accountId,
    failed.current_attempt_id,
    'failed-result','1','6625','VND','FAILED',true);
  assert.equal(firstFailure.payment_status,'PAYMENT_FAILED');
  const retried=await ledger.retry(failed.payment_id,failedCtx.customerId,accountId,
    'retry-1','2','DEMO_TRANSFER');
  assert.equal(retried.payment_status,'PAYMENT_PENDING');
  assert.notEqual(retried.current_attempt_id,failed.current_attempt_id);
  const page1=await ledger.listAttempts(failed.payment_id,accountId,1);
  assert.equal(page1.items.length,1);
  assert.equal(page1.items[0].status,'PAYMENT_FAILED');
  assert.equal(typeof page1.next_cursor,'string');
  const page2=await ledger.listAttempts(failed.payment_id,accountId,1,page1.next_cursor);
  assert.equal(page2.items.length,1);
  assert.equal(page2.items[0].status,'PAYMENT_PENDING');
  assert.equal(page2.next_cursor,undefined);
  await rejected(()=>ledger.listAttempts(failed.payment_id,randomUUID(),1,page1.next_cursor),
    'VALIDATION_ERROR');
  await rejected(()=>ledger.listAttempts(failed.payment_id,accountId,2,page1.next_cursor),
    'VALIDATION_ERROR');
  await rejected(()=>ledger.result(failed.payment_id,failedCtx.customerId,accountId,
    failed.current_attempt_id,'late-failed','3','6625','VND','FAILED',true),
    'PAYMENT_ATTEMPT_CONFLICT');
  const cashCtx={...ctx,tripId:randomUUID(),bookingId:randomUUID()};
  const cash=await ledger.create(cashCtx,accountId,'cash-create','CASH');
  assert.equal((await ledger.tripStartDecision(cashCtx.tripId)).can_start_trip,true);
  await rejected(()=>ledger.confirmCash(cash.payment_id,cashCtx.driverAccountId,cashCtx.driverId,
    'cash-confirm','1',false),'TRIP_NOT_COMPLETED');
  const driverAccount=cashCtx.driverAccountId;
  const done=await ledger.confirmCash(cash.payment_id,driverAccount,cashCtx.driverId,
    'cash-confirm','1',true);
  assert.equal(done.payment_status,'PAYMENT_SUCCESS');
  assert.deepEqual(await ledger.confirmCash(cash.payment_id,driverAccount,cashCtx.driverId,
    'cash-confirm','1',true),done);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM payment_outbox WHERE payment_id=$1',
    [cash.payment_id])).rows[0].n,1);
  console.info('PASS disposable PostgreSQL: price/snapshot/replay/route/MOTORBIKE, concurrent create, cash, demo result, amount, duplicate/outbox');
} finally {
  await admin.query(`UPDATE demo_route SET distance_meters=1250
    WHERE route_id='57240a8d-9114-4d1d-986f-90814e0eec8b'`).catch(()=>undefined);
  await runtime.end();await admin.end();
}
