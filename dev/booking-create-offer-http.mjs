// Opt-in live Gateway regression for the single-request rubric 15 response.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';

const base='http://127.0.0.1:33201';
const fixtures=JSON.parse(readFileSync(new URL('../.secrets/customer-dev/nearby-demo/drivers.json',
  import.meta.url),'utf8'));
async function call(path,{method='GET',token,body,headers={}}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{ }),
    ...(body?{'Content-Type':'application/json'}:{ }),...headers},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  return {status:response.status,body:await response.json(),headers:response.headers};
}
function expect(result,status,label) {
  assert.equal(result.status,status,`${label}: ${result.body?.errorCode??result.status}`);
  return result.body;
}
const suffix=randomBytes(8).toString('hex');
const email=`cab-booking-offer-${suffix}@example.test`;
const phone='09'+String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0');
const password=randomBytes(24).toString('base64url')+'!';
const registered=expect(await call('/v1/auth/register',{method:'POST',body:{
  fullName:'CAB Booking Offer Regression',email,phone,password}}),201,'register Customer');
assert.equal(registered.role,'CUSTOMER');
const customer=expect(await call('/v1/auth/login',{method:'POST',body:{
  emailOrPhone:email,password}}),200,'login Customer').accessToken;
let bookingId;
try {
  const result=expect(await call('/v1/bookings',{method:'POST',token:customer,body:{
    pickup:{latitude:10.7769,longitude:106.7009,address:'Demo pickup'},
    destination:{latitude:10.7869,longitude:106.7109,address:'Demo destination'},
    vehicleType:'MOTORBIKE'}}),201,'create Booking');
  bookingId=result.bookingId;
  assert.equal(result.bookingStatus,'PENDING');
  assert.equal(result.pricingSnapshot.distanceMeters,1250);
  assert.equal(result.pricingSnapshot.totalAmount,6625);
  assert.equal(result.dispatchStatus,'SEARCHING');
  assert.equal(result.initialOffer?.status,'PENDING');
  assert.match(result.initialOffer?.tripRequestId??'',/^[0-9a-f-]{36}$/);
  assert.match(result.initialOffer?.driverId??'',/^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(result.initialOffer.expiresAt)>Date.now());
  const offerLifetime=Date.parse(result.initialOffer.expiresAt)-
    Date.parse(result.initialOffer.sentAt);
  assert.ok(offerLifetime>=119000&&offerLifetime<=120000,
    `Expected a 120-second first offer, got ${offerLifetime}ms`);
  const selected=fixtures.find(item=>item.driverId===result.initialOffer.driverId);
  assert.ok(selected,'Offer went to a Driver outside the dedicated fixture');
  if(process.env.CAB_EXPECTED_DEMO_DRIVER_ID)
    assert.equal(selected.driverId,process.env.CAB_EXPECTED_DEMO_DRIVER_ID,
      'Offer did not reach the expected Postman Driver');
  const driver=expect(await call('/v1/auth/login',{method:'POST',body:{
    emailOrPhone:selected.email,password:selected.password}}),200,'login selected Driver').accessToken;
  const offers=expect(await call('/v1/drivers/me/trip-requests?limit=20',{
    token:driver}),200,'Driver pending offers');
  assert.ok(offers.items.some(item=>item.tripRequestId===result.initialOffer.tripRequestId&&
    item.bookingId===bookingId&&item.driverId===selected.driverId&&item.status==='PENDING'));
  let delivered=false;
  for(let attempt=0;attempt<20;attempt++) {
    const inbox=expect(await call('/v1/notifications?limit=50',{token:driver}),
      200,'Driver Notification inbox');
    const matches=inbox.items.filter(item=>item.eventType==='TRIP_REQUEST_RECEIVED'&&
      item.referenceId===result.initialOffer.tripRequestId);
    assert.ok(matches.length<=1,'Duplicate offer Notification');
    if(matches.length===1) {delivered=true;break;}
    await new Promise(resolve=>setTimeout(resolve,400));
  }
  assert.ok(delivered,'Offer Notification was not delivered to the selected Driver');
  console.log('PASS live POST Booking 201: PENDING snapshot, SEARCHING, persisted PENDING offer, matching Driver-visible tripRequestId, and one RabbitMQ/MongoDB Notification.');
} finally {
  if(bookingId) {
    let cancelled=await call(`/v1/bookings/${bookingId}/cancel`,{method:'POST',
      token:customer,body:{reason:'Synthetic response regression cleanup'}});
    if(cancelled.status===202) {
      for(let i=0;i<25;i++) {
        await new Promise(resolve=>setTimeout(resolve,400));
        const operation=await call(`/v1/booking-operations/${cancelled.body.operationId}`,
          {token:customer});
        if(operation.status===200&&operation.body.status==='SUCCEEDED') {
          cancelled={status:200,body:operation.body.result};break;
        }
      }
    }
    assert.equal(cancelled.status,200,'Test Booking cancellation did not finish');
    assert.equal(cancelled.body.bookingStatus,'CANCELLED');
  }
}
