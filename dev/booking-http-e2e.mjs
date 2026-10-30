// Opt-in demo fixture and HTTP integration. Never edits existing accounts or removes data.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';

const root=new URL('../',import.meta.url);
const stateFile=new URL('../.secrets/customer-dev/booking_http_e2e.json',import.meta.url);
const secret=name=>readFileSync(new URL(`../.secrets/customer-dev/${name}`,import.meta.url),'utf8').trim();
const base='http://127.0.0.1:33201';
const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):
  {customers:[],drivers:[],bookings:[]};
const save=()=>writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=(label,result)=>new Error(`${label}: HTTP ${result.status} ${result.body?.errorCode??result.body?.status??''}`);
async function call(path,{method='GET',token,body,headers={}}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{'Cache-Control':'no-store'}),
    ...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  return {status:response.status,contentType:response.headers.get('content-type'),
    body:await response.json()};
}
function expect(result,status,label) {if(result.status!==status) throw fail(label,result);return result.body;}
async function login(entry) {return expect(await call('/v1/auth/login',{method:'POST',
  body:{emailOrPhone:entry.email,password:entry.password}}),200,'login').accessToken;}
function identity(prefix) {const suffix=randomBytes(7).toString('hex');return {
  email:`cab-booking-${prefix}-${suffix}@example.test`,
  phone:'09'+String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0'),
  password:randomBytes(24).toString('base64url')+'!'};}
async function customer() {
  const entry=identity('customer');
  const recovery=randomBytes(32).toString('base64url');
  let result=await call('/v1/auth/register',{method:'POST',body:{fullName:'CAB Booking Demo Customer',
    email:entry.email,phone:entry.phone,password:entry.password},
    headers:{'Idempotency-Key':randomUUID(),'Registration-Recovery-Token':recovery}});
  if(result.status===202) {
    const op=result.body.operationId;
    for(let i=0;i<20;i++) {await pause(400);
      const found=await call(`/v1/auth/customer-registrations/${op}`,{
        headers:{'Registration-Recovery-Token':recovery}});
      if(found.status===200&&found.body.status==='SUCCEEDED') {
        result={status:201,body:found.body.result};break;}
    }
  }
  const created=expect(result,201,'register customer');
  state.customers.push({...entry,accountId:created.accountId,customerId:created.customerId});
  save();console.info(`Prepared synthetic Customer ${state.customers.length}`);
}
async function driver(operator,index) {
  const entry=identity('driver');
  const requested=expect(await call('/v1/auth/driver-registration/otp',{method:'POST',
    body:{phone:entry.phone}}),202,'request driver OTP');
  if(typeof requested.otp!=='string'||!requested.otp)
    throw new Error('Opt-in OTP response is disabled; no test-only bypass');
  const verified=expect(await call('/v1/auth/driver-registration/otp/verify',{method:'POST',
    body:{challengeId:requested.challengeId,otp:requested.otp}}),200,'verify driver OTP');
  const submitted=await call('/v1/driver-applications',{method:'POST',
    body:{verificationToken:verified.verificationToken,fullName:'CAB Booking Demo Driver',
      email:entry.email,password:entry.password,
      licenseNumber:`CAB-BOOK-${randomBytes(5).toString('hex').toUpperCase()}`,
      vehicle:{plateNumber:`BOOK-${randomBytes(4).toString('hex').toUpperCase()}`,
        vehicleType:'MOTORBIKE'}}});
  let created=submitted.body;
  if(submitted.status===202) {
    for(let i=0;i<20;i++) {await pause(500);
      const found=await call(`/v1/driver-registration-operations/${created.operationId}`,{
        headers:{'Driver-Registration-Token':verified.verificationToken}});
      if(found.status===200&&found.body.status==='SUCCEEDED') {created=found.body.result;break;}
    }
  } else expect(submitted,201,'register driver');
  if(!created.applicationId||!created.driverId) throw new Error('Driver operation did not complete');
  const token=await login(entry);
  const application=expect(await call(`/v1/operations/driver-applications/${created.applicationId}`,
    {token:operator}),200,'operator application detail');
  const before=expect(await call('/v1/drivers/me',{token}),200,'driver profile before review');
  const reviewed=expect(await call(`/v1/operations/driver-applications/${created.applicationId}/review`,
    {method:'POST',token:operator,body:{expectedVersion:application.version,
      expectedDriverVersion:before.driver.version,decision:'APPROVED'}}),200,'approve driver');
  assert.equal(reviewed.application.status,'APPROVED');
  state.drivers.push({...entry,accountId:created.accountId,driverId:created.driverId,
    applicationId:created.applicationId,vehicleId:reviewed.vehicle.vehicleId,
    latitude:10.7769+index*0.0002,longitude:106.7009});
  save();console.info(`Prepared synthetic Driver ${state.drivers.length}`);
}
async function fresh(driverEntry) {
  const token=await login(driverEntry);
  expect(await call('/v1/drivers/me/location',{method:'PUT',token,body:{
    latitude:driverEntry.latitude,longitude:driverEntry.longitude,
    recordedAt:new Date(Date.now()-1000).toISOString()}}),200,'driver GPS');
  const profile=expect(await call('/v1/drivers/me',{token}),200,'driver profile');
  if(profile.driver.driverStatus==='OFFLINE')
    expect(await call('/v1/drivers/me/availability',{method:'PUT',token,
      body:{expectedVersion:profile.driver.version,driverStatus:'AVAILABLE'}}),200,'driver AVAILABLE');
  return token;
}
async function booking(customerEntry) {
  const token=await login(customerEntry);
  const existing=expect(await call('/v1/bookings?limit=20',{token}),200,'list own bookings');
  const active=existing.items.find(item=>['PENDING','FINDING_DRIVER','DRIVER_ASSIGNED']
    .includes(item.bookingStatus));
  let result=active?{status:201,body:expect(await call(
    `/v1/bookings/${active.bookingId}`,{token}),200,'resume own Booking')}:
    await call('/v1/bookings',{method:'POST',token,body:{
    pickup:{latitude:10.7769,longitude:106.7009,address:'Demo pickup'},
    destination:{latitude:10.7869,longitude:106.7109,address:'Demo destination'},
    vehicleType:'MOTORBIKE'}});
  if(result.status===202) {
    for(let i=0;i<20;i++) {await pause(500);
      const found=await call(`/v1/booking-operations/${result.body.operationId}`,{token});
      if(found.status===200&&found.body.status==='SUCCEEDED') {
        result={status:201,body:found.body.result};break;}
      if(found.status===200&&found.body.status==='FAILED')
        throw new Error(`Booking operation failed: ${found.body.error?.errorCode}`);
    }
  }
  const created=expect(result,201,'create Booking');
  assert.equal(created.pricingSnapshot.totalAmount,6625);
  if(!state.bookings.some(item=>item.bookingId===created.bookingId))
    state.bookings.push({bookingId:created.bookingId,
      customerAccountId:customerEntry.accountId,customerId:customerEntry.customerId});
  save();
  console.info(`Created synthetic Booking ${state.bookings.length}: 201, fixed fare 6625 VND`);
  return {created,token};
}
async function assigned(customerEntry,race=false) {
  const existing=state.bookings.find(item=>item.customerId===customerEntry.customerId&&item.tripId);
  if(existing?.tripId) {
    const customerToken=await login(customerEntry);
    const driverEntry=state.drivers.find(entry=>entry.driverId===existing.driverId);
    if(!driverEntry) throw new Error('Assigned fixture Driver missing');
    return {tripId:existing.tripId,driverToken:await login(driverEntry),customerToken,
      driverEntry,customerEntry};
  }
  const driverTokens=await Promise.all(state.drivers.map(async entry=>{
    try {return await fresh(entry);} catch(error) {
      if(error instanceof Error&&error.message.includes('DRIVER_NOT_ELIGIBLE')) return null;
      throw error;
    }
  }));
  assert.ok(driverTokens.some(Boolean),'at least one fixture Driver is eligible');
  const {created,token:customerToken}=await booking(customerEntry);
  let offer,driverEntry,driverToken;
  for(let i=0;i<30;i++) {await pause(500);
    for(let j=0;j<state.drivers.length;j++) {
      if(!driverTokens[j]) continue;
      const listed=expect(await call('/v1/drivers/me/trip-requests?limit=20',
        {token:driverTokens[j]}),200,'Driver offers');
      offer=listed.items.find(item=>item.bookingId===created.bookingId);
      if(offer) {driverEntry=state.drivers[j];driverToken=driverTokens[j];break;}
    }
    if(offer) break;
    if(i%12===11) for(let j=0;j<state.drivers.length;j++) {
      if(driverTokens[j]) await fresh(state.drivers[j]);
    }
  }
  if(!offer) throw new Error('No real dispatch offer reached the prepared Driver');
  const accept=()=>call(`/v1/trip-requests/${offer.tripRequestId}/accept`,{
    method:'POST',token:driverToken,body:{}});
  const responses=race?await Promise.all([accept(),accept()]):[await accept()];
  const resolved=[];
  const rejected=[];
  for(let accepted of responses) {
    if(accepted.status===202) {
      for(let i=0;i<20;i++) {await pause(500);
        const found=await call(`/v1/dispatch-operations/${accepted.body.operationId}`,
          {token:driverToken});
        if(found.status===200&&found.body.status==='SUCCEEDED') {
          accepted={status:200,body:found.body.result};break;}
      }
    }
    if(race&&accepted.status===409&&accepted.body?.errorCode==='DRIVER_NOT_AVAILABLE') {
      rejected.push(accepted.body.errorCode);
      continue;
    }
    resolved.push(expect(accepted,200,'accept offer'));
  }
  if(race) {
    assert.ok(resolved.length>=1,'at least one concurrent accept succeeds');
    assert.equal(new Set(resolved.map(item=>item.tripId)).size,1,
      'parallel same-offer acceptance resolves one Trip');
    console.info(`Concurrent accept results: ${resolved.length} success, ${rejected.length} DRIVER_NOT_AVAILABLE`);
  }
  const result=resolved[0];
  const tripId=result.tripId;
  if(!tripId) throw new Error('Accepted offer has no Trip ID');
  const trip=expect(await call(`/v1/trips/${tripId}`,{token:customerToken}),200,'read Trip');
  assert.equal(trip.tripStatus,'DRIVER_ASSIGNED');
  const fixture=state.bookings.find(item=>item.bookingId===created.bookingId);
  fixture.tripId=tripId;fixture.driverId=driverEntry.driverId;save();
  console.info('Assignment: offer accepted; Trip DRIVER_ASSIGNED via HTTP/mTLS');
  return {tripId,driverToken,customerToken,driverEntry,customerEntry};
}
async function move(flow,trip,next) {
  const result=expect(await call(`/v1/trips/${flow.tripId}/status`,{
    method:'PATCH',token:flow.driverToken,
    body:{expectedVersion:trip.version,tripStatus:next}}),200,`Trip ${next}`);
  assert.equal(result.tripStatus,next);
  return result;
}
async function payment(flow,method) {
  const known=state.bookings.find(item=>item.tripId===flow.tripId);
  if(known?.paymentId) return expect(await call(`/v1/payments/${known.paymentId}`,
    {token:flow.customerToken}),200,'resume Payment');
  const key=randomUUID();
  const create=()=>call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':key},
    body:{paymentMethod:method}});
  const concurrent=await Promise.all([create(),create()]);
  const first=expect(concurrent[0],201,`create ${method} Payment`);
  assert.equal(expect(concurrent[1],201,'concurrent same-key Payment').paymentId,
    first.paymentId);
  assert.equal(first.amount,6625);assert.equal(first.method,method);
  const fare=expect(await call(`/v1/trips/${flow.tripId}/fare`,
    {token:flow.customerToken}),200,'fare');
  assert.equal(fare.totalAmount,6625);
  const replay=expect(await call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':key},
    body:{paymentMethod:method}}),201,'Payment idempotent replay');
  assert.equal(replay.paymentId,first.paymentId);
  const changed=await call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':key},
    body:{paymentMethod:method==='CASH'?'DEMO_TRANSFER':'CASH'}});
  assert.equal(changed.status,409);assert.equal(changed.body.errorCode,'IDEMPOTENCY_CONFLICT');
  const newKey=await call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{paymentMethod:method}});
  assert.equal(newKey.status,409);assert.equal(newKey.body.errorCode,'PAYMENT_ALREADY_EXISTS');
  const attempts=expect(await call(`/v1/payments/${first.paymentId}/attempts?limit=20`,
    {token:flow.customerToken}),200,'single Payment attempt');
  assert.equal(attempts.items.length,1);
  state.bookings.at(-1).paymentId=first.paymentId;save();
  return first;
}
async function notifications(token,required) {
  for(let i=0;i<20;i++) {await pause(500);
    const result=expect(await call('/v1/notifications?limit=50',{token}),200,'Notification list');
    if(required.every(({type,id})=>result.items.some(item=>
      item.eventType===type&&item.referenceId===id))) {
      for(const {type,id} of required)
        assert.equal(result.items.filter(item=>item.eventType===type&&
          item.referenceId===id).length,1,`${type} Notification delivered once`);
      return result.items;
    }
  }
  throw new Error('Expected Notification not delivered through RabbitMQ and MongoDB');
}
async function cash(flow) {
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'read Trip');
  const early=await call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{paymentMethod:'CASH'}});
  assert.equal(early.status,409,'new Payment cannot be created before COMPLETED');
  assert.equal(early.body.errorCode,'TRIP_NOT_PAYABLE');
  trip=await move(flow,trip,'ARRIVED_PICKUP');
  trip=await move(flow,trip,'PICKED_UP');
  trip=await move(flow,trip,'IN_PROGRESS');
  expect(await call('/v1/drivers/me/location',{method:'PUT',token:flow.driverToken,
    body:{latitude:flow.driverEntry.latitude+0.0001,
      longitude:flow.driverEntry.longitude+0.0001,
      recordedAt:new Date(Date.now()-1000).toISOString()}}),200,'assigned Driver GPS');
  let tracking;
  for(let i=0;i<20;i++) {await pause(400);
    tracking=expect(await call(`/v1/trips/${flow.tripId}/tracking`,
      {token:flow.customerToken}),200,'Customer tracking');
    if(tracking.trackingStatus==='LIVE') break;
  }
  assert.equal(tracking.tripStatus,'IN_PROGRESS');
  assert.equal(tracking.trackingStatus,'LIVE','assigned GPS handoff reached Trip');
  trip=await move(flow,trip,'COMPLETED');
  const paid=await payment(flow,'CASH');
  const key=randomUUID();
  const confirmed=expect(await call(`/v1/payments/${paid.paymentId}/confirm-cash`,{
    method:'POST',token:flow.driverToken,headers:{'Idempotency-Key':key},
    body:{expectedVersion:paid.version}}),200,'confirm cash');
  assert.equal(confirmed.paymentStatus,'SUCCESS');
  const replay=expect(await call(`/v1/payments/${paid.paymentId}/confirm-cash`,{
    method:'POST',token:flow.driverToken,headers:{'Idempotency-Key':key},
    body:{expectedVersion:paid.version}}),200,'cash replay');
  assert.equal(replay.paymentId,confirmed.paymentId);
  const closed=expect(await call(`/v1/trips/${flow.tripId}/tracking`,
    {token:flow.customerToken}),200,'closed tracking');
  assert.equal(closed.trackingStatus,'STOPPED');
  await notifications(flow.customerToken,[{type:'TRIP_COMPLETED',id:flow.tripId},
    {type:'PAYMENT_SUCCESS',id:paid.paymentId}]);
  console.info('PASS cash: fare, replay, early denial, Trip lifecycle, tracking, driver confirmation, closed privacy, Notification');
}
async function transfer(flow) {
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'read Trip');
  const early=await call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{paymentMethod:'DEMO_TRANSFER'}});
  assert.equal(early.status,409,'new transfer Payment cannot be created before COMPLETED');
  assert.equal(early.body.errorCode,'TRIP_NOT_PAYABLE');
  if(trip.tripStatus==='DRIVER_ASSIGNED') trip=await move(flow,trip,'ARRIVED_PICKUP');
  if(trip.tripStatus==='ARRIVED_PICKUP') trip=await move(flow,trip,'PICKED_UP');
  assert.equal(trip.tripStatus,'PICKED_UP');
  trip=await move(flow,trip,'IN_PROGRESS');
  trip=await move(flow,trip,'COMPLETED');
  const paid=await payment(flow,'DEMO_TRANSFER');
  const result=expect(await call(`/v1/payments/${paid.paymentId}/demo-result`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{attemptId:paid.currentAttemptId,expectedVersion:paid.version,
      expectedAmount:paid.amount,currency:'VND',outcome:'SUCCESS'}}),200,'demo transfer result');
  assert.equal(result.paymentStatus,'SUCCESS');
  await notifications(flow.customerToken,[{type:'TRIP_COMPLETED',id:flow.tripId},
    {type:'PAYMENT_SUCCESS',id:paid.paymentId}]);
  console.info('PASS transfer: Trip completion without Payment, post-trip Fare/replay, demo SUCCESS, Notification');
}
async function resumePostTripCash(flow) {
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'resume post-trip cash');
  assert.equal(trip.tripStatus,'IN_PROGRESS');
  trip=await move(flow,trip,'COMPLETED');
  const paid=await payment(flow,'CASH');
  const confirmed=expect(await call(`/v1/payments/${paid.paymentId}/confirm-cash`,{
    method:'POST',token:flow.driverToken,headers:{'Idempotency-Key':randomUUID()},
    body:{expectedVersion:paid.version}}),200,'post-trip cash confirmation');
  assert.equal(confirmed.paymentStatus,'SUCCESS');
  await notifications(flow.customerToken,[{type:'TRIP_COMPLETED',id:flow.tripId},
    {type:'PAYMENT_SUCCESS',id:paid.paymentId}]);
  console.info('PASS post-trip cash: unpaid Trip completed; Fare/Payment created and Driver confirmed after completion');
}
async function postTripCash(flow) {
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'post-trip cash Trip');
  const early=await call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{paymentMethod:'CASH'}});
  assert.equal(early.status,409);assert.equal(early.body.errorCode,'TRIP_NOT_PAYABLE');
  for(const next of ['ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS','COMPLETED'])
    trip=await move(flow,trip,next);
  const paid=await payment(flow,'CASH');
  const confirmed=expect(await call(`/v1/payments/${paid.paymentId}/confirm-cash`,{
    method:'POST',token:flow.driverToken,headers:{'Idempotency-Key':randomUUID()},
    body:{expectedVersion:paid.version}}),200,'post-trip cash confirmation');
  assert.equal(confirmed.paymentStatus,'SUCCESS');
  await notifications(flow.customerToken,[{type:'TRIP_COMPLETED',id:flow.tripId},
    {type:'PAYMENT_SUCCESS',id:paid.paymentId}]);
  console.info('PASS post-trip cash: early 409, unpaid Trip completed, Fare/replay and Driver confirmation');
}
async function pages() {
  const owner=state.customers[4],token=await login(owner);
  state.pages??=[];
  while(state.pages.length<5) {
    const {created}=await booking(owner);
    if(!state.pages.includes(created.bookingId)) {state.pages.push(created.bookingId);save();}
    const current=expect(await call(`/v1/bookings/${created.bookingId}`,{token}),
      200,'Booking detail');
    if(current.bookingStatus==='CANCELLED') continue;
    let cancelled=await call(`/v1/bookings/${created.bookingId}/cancel`,{
      method:'POST',token,body:{reason:'Dedicated pagination fixture'}});
    if(cancelled.status===202) {
      for(let i=0;i<25;i++) {await pause(300);
        const found=expect(await call(`/v1/booking-operations/${cancelled.body.operationId}`,
          {token}),200,'cancel operation');
        if(found.status==='SUCCEEDED') {cancelled={status:200,body:found.result};break;}
      }
    }
    assert.equal(expect(cancelled,200,'cancel fixture Booking').bookingStatus,'CANCELLED');
  }
  const first=expect(await call('/v1/bookings?limit=2',{token}),200,'Booking page 1');
  assert.equal(first.items.length,2);assert.equal(first.hasMore,true);
  assert.ok(first.nextCursor);
  const second=expect(await call(`/v1/bookings?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    {token}),200,'Booking page 2');
  assert.equal(second.items.length,2);
  const other=await login(state.customers[3]);
  const denied=await call(`/v1/bookings/${state.pages[0]}`,{token:other});
  assert.equal(denied.status,404,'other Customer cannot read Booking');
  const driver=await login(state.drivers[0]);
  const wrongRole=await call('/v1/bookings',{method:'POST',token:driver,body:{
    pickup:{latitude:10.7769,longitude:106.7009,address:'Demo pickup'},
    destination:{latitude:10.7869,longitude:106.7109,address:'Demo destination'},
    vehicleType:'MOTORBIKE'}});
  assert.equal(wrongRole.status,403,'Driver cannot create Customer Booking');
  console.info('PASS pages: five own Booking fixtures, page size 2/cursor, cancellation, owner 404 and role 403');
}
async function nearby() {
  for(const entry of state.drivers) await fresh(entry);
  const token=await login(state.customers[0]);
  const seen=new Set();let cursor;
  for(let i=0;i<30;i++) {
    const query=`latitude=10.7769&longitude=106.7009&radiusKm=1&limit=2`+
      (cursor?`&cursor=${encodeURIComponent(cursor)}`:'');
    const page=expect(await call(`/v1/drivers/nearby?${query}`,{token}),200,'nearby page');
    assert.ok(page.items.length<=2);
    for(const item of page.items) {assert.ok(item.distanceMeters<=1000);seen.add(item.driverId);}
    if(!page.hasMore) break;
    cursor=page.nextCursor;assert.ok(cursor);
  }
  assert.ok(state.drivers.filter(entry=>seen.has(entry.driverId)).length>=5,
    'at least five prepared Drivers appear in 1 km pages');
  const far=expect(await call('/v1/drivers/nearby?latitude=11.7769&longitude=106.7009&radiusKm=1&limit=2',
    {token}),200,'far nearby');
  assert.equal(far.items.length,0);
  console.info('PASS nearby: five fixture Drivers within 1 km via page size 2/cursor; far location empty 200');
}
async function audit() {
  for(let i=0;i<3;i++) {
    const customerEntry=state.customers[i],token=await login(customerEntry);
    const bookingEntry=state.bookings.find(item=>
      item.customerId===customerEntry.customerId&&item.tripId&&item.paymentId);
    if(!bookingEntry) throw new Error('Run cash and transfer first');
    const trip=expect(await call(`/v1/trips/${bookingEntry.tripId}`,{token}),
      200,'audited Trip');
    const paymentResult=expect(await call(`/v1/payments/${bookingEntry.paymentId}`,
      {token}),200,'audited Payment');
    assert.equal(trip.tripStatus,'COMPLETED');
    assert.equal(paymentResult.paymentStatus,'SUCCESS');
    assert.equal(paymentResult.amount,6625);
    const closure=expect(await call(`/v1/trips/${bookingEntry.tripId}/closure`,
      {token}),200,'completed closure');
    assert.equal(closure.status,'SUCCEEDED');
    await notifications(token,[{type:'TRIP_COMPLETED',
      id:bookingEntry.tripId},
      {type:'PAYMENT_SUCCESS',id:bookingEntry.paymentId}]);
  }
  console.info('PASS audit: three completed Trip/Payment records persisted; closure/release SUCCEEDED; exact Notification references delivered once');
}
async function unpaidCancel() {
  await customer();
  const flow=await assigned(state.customers.at(-1));
  const trip=expect(await call(`/v1/trips/${flow.tripId}`,
    {token:flow.customerToken}),200,'unpaid cancel Trip');
  assert.equal(trip.tripStatus,'DRIVER_ASSIGNED');
  const cancelled=expect(await call(`/v1/trips/${flow.tripId}/cancel`,{
    method:'POST',token:flow.customerToken,
    body:{reason:'Dedicated post-trip Payment cancellation test'}}),200,'cancel unpaid Trip');
  assert.equal(cancelled.tripStatus,'CANCELLED');
  const create=await call(`/v1/trips/${flow.tripId}/payments`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{paymentMethod:'CASH'}});
  assert.equal(create.status,409);assert.equal(create.body.errorCode,'TRIP_NOT_PAYABLE');
  await notifications(flow.customerToken,[{type:'TRIP_CANCELLED',id:flow.tripId}]);
  console.info('PASS unpaid-cancel: cancelled Trip cannot create post-trip Payment');
}
async function failedRetry() {
  const flow=await assigned(state.customers[2]);
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'retry Trip');
  if(trip.tripStatus==='DRIVER_ASSIGNED') trip=await move(flow,trip,'ARRIVED_PICKUP');
  if(trip.tripStatus==='ARRIVED_PICKUP') trip=await move(flow,trip,'PICKED_UP');
  if(trip.tripStatus==='PICKED_UP') trip=await move(flow,trip,'IN_PROGRESS');
  if(trip.tripStatus==='IN_PROGRESS') trip=await move(flow,trip,'COMPLETED');
  assert.equal(trip.tripStatus,'COMPLETED');
  let paid=await payment(flow,'DEMO_TRANSFER');
  if(paid.paymentStatus==='PENDING') {
    paid=expect(await call(`/v1/payments/${paid.paymentId}/demo-result`,{
      method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
      body:{attemptId:paid.currentAttemptId,expectedVersion:paid.version,
        expectedAmount:paid.amount,currency:'VND',outcome:'FAILED'}}),200,'demo FAILED');
  }
  assert.equal(paid.paymentStatus,'FAILED');
  assert.equal(expect(await call(`/v1/trips/${flow.tripId}`,
    {token:flow.customerToken}),200,'Trip after failed Payment').tripStatus,'COMPLETED');
  paid=expect(await call(`/v1/payments/${paid.paymentId}/retry`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{expectedVersion:paid.version,paymentMethod:'DEMO_TRANSFER'}}),202,'retry failed Payment');
  assert.equal(paid.paymentStatus,'PENDING');
  paid=expect(await call(`/v1/payments/${paid.paymentId}/demo-result`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{attemptId:paid.currentAttemptId,expectedVersion:paid.version,
      expectedAmount:paid.amount,currency:'VND',outcome:'SUCCESS'}}),200,'retry SUCCESS');
  assert.equal(paid.paymentStatus,'SUCCESS');
  await notifications(flow.customerToken,[{type:'PAYMENT_FAILED',id:paid.paymentId},
    {type:'PAYMENT_SUCCESS',id:paid.paymentId},{type:'TRIP_COMPLETED',id:flow.tripId}]);
  console.info('PASS failed-retry: completed Trip retained, FAILED Payment, new attempt, SUCCESS, distinct Notifications');
}
async function paidCancel() {
  const flow=await assigned(state.customers[3]);
  const trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'cancel Trip');
  assert.equal(trip.tripStatus,'DRIVER_ASSIGNED');
  if(!state.bookings.find(item=>item.tripId===flow.tripId)?.paymentId)
    throw new Error('paid-cancel requires a Payment created by the earlier workflow; use unpaid-cancel for new Trips');
  let paid=await payment(flow,'DEMO_TRANSFER');
  paid=expect(await call(`/v1/payments/${paid.paymentId}/demo-result`,{
    method:'POST',token:flow.customerToken,headers:{'Idempotency-Key':randomUUID()},
    body:{attemptId:paid.currentAttemptId,expectedVersion:paid.version,
      expectedAmount:paid.amount,currency:'VND',outcome:'SUCCESS'}}),200,'paid before cancellation');
  const cancelled=expect(await call(`/v1/trips/${flow.tripId}/cancel`,{
    method:'POST',token:flow.customerToken,body:{expectedVersion:trip.version,
      reasonCode:'CHANGE_OF_PLANS',reason:'Dedicated paid cancellation fixture'}}),
    200,'cancel paid Trip');
  assert.equal(cancelled.tripStatus,'CANCELLED');
  let reviewed;
  for(let i=0;i<25;i++) {await pause(400);
    reviewed=expect(await call(`/v1/payments/${paid.paymentId}`,
      {token:flow.customerToken}),200,'Payment after cancellation');
    if(reviewed.requiresReview) break;
  }
  assert.equal(reviewed.paymentStatus,'SUCCESS');
  assert.equal(reviewed.requiresReview,true,'paid cancellation requires manual review');
  await notifications(flow.customerToken,[{type:'TRIP_CANCELLED',id:flow.tripId},
    {type:'PAYMENT_SUCCESS',id:paid.paymentId}]);
  console.info('PASS paid-cancel: Trip cancelled before start; Payment stays SUCCESS and requires manual review');
}
async function incident() {
  if(state.drivers.length<6) {
    const operatorSeed=JSON.parse(secret('operator_seed.json'));
    const operator=await login({email:operatorSeed.email,
      password:secret('operator_demo_password')});
    await driver(operator,5);
  }
  if(state.incidentTripId) {
    const token=await login(state.customers[4]);
    const trip=expect(await call(`/v1/trips/${state.incidentTripId}`,{token}),
      200,'incident replay read');
    assert.equal(trip.tripStatus,'ERROR');
    console.info('PASS incident existing synthetic Trip remains ERROR and unclosed');
    return;
  }
  const flow=await assigned(state.customers[4]);
  const trip=expect(await call(`/v1/trips/${flow.tripId}`,
    {token:flow.customerToken}),200,'incident Trip');
  assert.equal(trip.tripStatus,'DRIVER_ASSIGNED');
  const reported=expect(await call(`/v1/trips/${flow.tripId}/incidents`,{
    method:'POST',token:flow.driverToken,
    body:{expectedVersion:trip.version,issueType:'OTHER',
      description:'Dedicated synthetic Trip incident'}}),201,'report incident');
  assert.equal(reported.trip.tripStatus,'ERROR');
  assert.equal(reported.incident.status,'OPEN');
  const closure=await call(`/v1/trips/${flow.tripId}/closure`,
    {token:flow.customerToken});
  assert.equal(closure.status,409,'unclosed ERROR does not release reservation');
  await notifications(flow.customerToken,[{type:'TRIP_ERROR',id:flow.tripId}]);
  state.incidentTripId=flow.tripId;save();
  console.info('PASS incident: assigned Driver reports ERROR; unclosed Trip retains reservation and emits one Notification');
}
async function resolveIncident() {
  const operatorSeed=JSON.parse(secret('operator_seed.json'));
  const operator=await login({email:operatorSeed.email,password:secret('operator_demo_password')});
  await customer();
  const flow=await assigned(state.customers.at(-1));
  const route=`/v1/operations/trips/${flow.tripId}/resolve-error`;
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'resolution Trip');
  const first=expect(await call(`/v1/trips/${flow.tripId}/incidents`,{
    method:'POST',token:flow.driverToken,
    body:{expectedVersion:trip.version,issueType:'OTHER',description:'Synthetic restore incident'}}),
  201,'restore incident');
  trip=first.trip;
  const restore={expectedTripVersion:trip.version,resolutionAction:'RESTORE_PREVIOUS_STATUS',
    resolutionNote:'Synthetic Operator verified assignment and restored status'};
  assert.equal((await call(route,{method:'POST',token:flow.customerToken,body:restore})).status,403);
  assert.equal((await call(route,{method:'POST',token:flow.driverToken,body:restore})).status,403);
  assert.equal((await call(route,{method:'POST',body:restore})).status,401);
  const stale=await call(route,{method:'POST',token:operator,
    body:{...restore,expectedTripVersion:trip.version-1}});
  assert.equal(stale.status,409);
  assert.equal(stale.body.errorCode,'TRIP_VERSION_CONFLICT');
  const recovered=expect(await call(route,{method:'POST',token:operator,body:restore}),
    200,'Operator restore');
  assert.equal(recovered.trip.tripStatus,'DRIVER_ASSIGNED');
  assert.equal(recovered.trip.statusBeforeError,undefined);
  assert.ok(recovered.resolvedIncidentIds.includes(first.incident.incidentId));
  const replay=expect(await call(route,{method:'POST',token:operator,body:restore}),
    200,'restore replay');
  assert.deepEqual(replay,recovered);
  trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'restored Trip');
  const second=expect(await call(`/v1/trips/${flow.tripId}/incidents`,{
    method:'POST',token:flow.driverToken,
    body:{expectedVersion:trip.version,issueType:'VEHICLE_BREAKDOWN',
      description:'Synthetic breakdown for abnormal closure'}}),201,'close incident');
  const close={expectedTripVersion:second.trip.version,resolutionAction:'CLOSE_ABNORMALLY',
    resolutionNote:'Synthetic breakdown, close without completing trip'};
  const closed=expect(await call(route,{method:'POST',token:operator,body:close}),
    200,'abnormal close');
  assert.equal(closed.trip.tripStatus,'ERROR');
  assert.ok(closed.trip.closedAt);
  assert.equal(closed.trip.closeReason,close.resolutionNote);
  assert.ok(closed.resolvedIncidentIds.includes(second.incident.incidentId));
  assert.deepEqual(expect(await call(route,{method:'POST',token:operator,body:close}),
    200,'close replay'),closed);
  const conflicting=await call(route,{method:'POST',token:operator,
    body:{...close,resolutionNote:'A different action note'}});
  assert.equal(conflicting.status,409);
  assert.equal(conflicting.body.errorCode,'TRIP_NOT_RESOLVABLE');
  let closure;
  for(let i=0;i<25;i++) {await pause(400);
    closure=await call(`/v1/trips/${flow.tripId}/closure`,{token:flow.customerToken});
    if(closure.status===200&&closure.body.status==='SUCCEEDED') break;}
  assert.equal(closure.status,200);
  assert.equal(closure.body.status,'SUCCEEDED');
  const driverProfile=expect(await call('/v1/drivers/me',{token:flow.driverToken}),
    200,'released Driver profile');
  assert.equal(driverProfile.driver.driverStatus,'OFFLINE');
  assert.equal(driverProfile.vehicle.vehicleStatus,'INACTIVE');
  await notifications(flow.customerToken,[{type:'TRIP_RECOVERED',id:flow.tripId},
    {type:'TRIP_CLOSED_ABNORMALLY',id:flow.tripId}]);
  console.info('PASS Trip ERROR HTTP: role/version denials, restore/replay, abnormal close/replay, closure releases exact synthetic assignment, vehicle blocked, two notifications');
}
async function race() {
  // Each opt-in race run needs a fresh Customer with no prior active Booking.
  await customer();
  const index=state.customers.length-1;
  const flow=await assigned(state.customers[index],true);
  const trips=expect(await call('/v1/trips?limit=20',
    {token:flow.customerToken}),200,'race Customer Trips');
  const fixture=state.bookings.find(item=>item.tripId===flow.tripId);
  assert.equal(trips.items.filter(item=>item.bookingId===fixture.bookingId).length,1,
    'one Trip for concurrent accept');
  const trip=expect(await call(`/v1/trips/${flow.tripId}`,
    {token:flow.customerToken}),200,'race Trip');
  const cancelled=expect(await call(`/v1/trips/${flow.tripId}/cancel`,{
    method:'POST',token:flow.customerToken,
    body:{expectedVersion:trip.version,reasonCode:'CHANGE_OF_PLANS',
      reason:'Dedicated concurrent accept fixture'}}),200,'race Trip cancellation');
  assert.equal(cancelled.tripStatus,'CANCELLED');
  let closure;
  for(let i=0;i<25;i++) {await pause(400);
    closure=expect(await call(`/v1/trips/${flow.tripId}/closure`,
      {token:flow.customerToken}),200,'race closure');
    if(closure.status==='SUCCEEDED') break;
  }
  assert.equal(closure.status,'SUCCEEDED');
  console.info('PASS race: parallel same-offer accepts yield one Trip; cancellation releases both owner reservations');
}
async function rating() {
  await customer();
  const owner=state.customers.at(-1);
  const flow=await assigned(owner);
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),200,'Rating Trip');
  assert.equal((await call(`/v1/trips/${flow.tripId}/rating`,{method:'POST',
    token:flow.customerToken,body:{score:5,comment:'Chuyến đi an toàn'}})).status,409,
    'incomplete Trip cannot be rated');
  for(const status of ['ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS','COMPLETED'])
    trip=await move(flow,trip,status);
  const paid=await payment(flow,'CASH');
  const before=expect(await call(`/v1/payments/${paid.paymentId}`,
    {token:flow.customerToken}),200,'CASH remains pending');
  assert.equal(before.paymentStatus,'PENDING');
  const route=`/v1/trips/${flow.tripId}/rating`;
  const textOnly="<script>alert('hack')</script>";
  const body={score:5,comment:`  ${textOnly}  `};
  const created=await call(route,{method:'POST',token:flow.customerToken,body});
  assert.match(created.contentType??'',/^application\/json/);
  const first=expect(created,201,
    'Customer creates Rating before Payment SUCCESS');
  assert.equal(first.score,5);assert.equal(first.comment,textOnly);
  assert.equal(first.tripId,flow.tripId);assert.equal(first.customerId,owner.customerId);
  assert.equal(first.driverId,flow.driverEntry.driverId);
  const replay=expect(await call(route,{method:'POST',token:flow.customerToken,
    body:{score:5,comment:textOnly}}),201,'Rating replay');
  assert.equal(replay.ratingId,first.ratingId);
  const readBack=expect(await call(route,{token:flow.customerToken}),200,'read Rating');
  assert.equal(readBack.ratingId,first.ratingId);
  assert.equal(readBack.comment,textOnly);
  const conflict=await call(route,{method:'POST',token:flow.customerToken,
    body:{score:4,comment:textOnly}});
  assert.equal(conflict.status,409);assert.equal(conflict.body.errorCode,'RATING_ALREADY_EXISTS');
  const other=await login(state.customers[0]);
  assert.equal((await call(route,{method:'POST',token:other,body:{score:5}})).status,404);
  assert.equal((await call(route,{token:other})).status,404);
  assert.equal((await call(route,{method:'POST',token:flow.driverToken,body:{score:5}})).status,403);
  const operatorSeed=JSON.parse(secret('operator_seed.json'));
  const operator=await login({email:operatorSeed.email,password:secret('operator_demo_password')});
  assert.equal((await call(route,{method:'POST',token:operator,body:{score:5}})).status,403);
  assert.equal((await call(route,{method:'POST',body:{score:5}})).status,401);
  assert.equal((await call(route,{method:'POST',token:'invalid',body:{score:5}})).status,401);
  assert.equal(expect(await call(route,{token:flow.driverToken}),200,'Driver reads own Rating').ratingId,
    first.ratingId);
  const driverList=expect(await call('/v1/drivers/me/ratings?limit=2',
    {token:flow.driverToken}),200,'Driver Rating list');
  assert.ok(driverList.items.some(item=>item.ratingId===first.ratingId));
  const operations=expect(await call(`/v1/operations/ratings?tripId=${flow.tripId}`,
    {token:operator}),200,'Operator Rating search');
  assert.equal(operations.items[0]?.ratingId,first.ratingId);
  const cancelled=state.bookings.find(item=>item.customerId===state.customers[3].customerId&&item.tripId);
  if(cancelled) assert.equal((await call(`/v1/trips/${cancelled.tripId}/rating`,{
    method:'POST',token:await login(state.customers[3]),body:{score:5}})).status,409,
    'cancelled Trip cannot be rated');
  state.ratingTripId=flow.tripId;state.ratingId=first.ratingId;state.ratingCustomerIndex=state.customers.length-1;save();
  console.info('PASS Rating HTTP: completed CASH PENDING Trip, normalized review, replay/conflict, role/owner/auth, Driver/Operator reads, incomplete/cancelled denial');
}
async function ratingRead() {
  if(!state.ratingTripId||!state.ratingId) throw new Error('Run rating first');
  const token=await login(state.customers[state.ratingCustomerIndex]);
  const found=expect(await call(`/v1/trips/${state.ratingTripId}/rating`,{token}),200,
    'Rating persists after Compose restart');
  assert.equal(found.ratingId,state.ratingId);
  console.info('PASS Rating read after restart: same Rating ID and owner');
}
async function paymentReplay() {
  await customer();
  const flow=await assigned(state.customers.at(-1));
  let trip=expect(await call(`/v1/trips/${flow.tripId}`,{token:flow.customerToken}),
    200,'replay Trip');
  for(const next of ['ARRIVED_PICKUP','PICKED_UP','IN_PROGRESS','COMPLETED'])
    trip=await move(flow,trip,next);
  const paid=await payment(flow,'DEMO_TRANSFER');
  const route=`/v1/payments/${paid.paymentId}/demo-result`;
  const key=randomUUID();
  const body={attemptId:paid.currentAttemptId,expectedVersion:paid.version,
    expectedAmount:paid.amount,currency:'VND',outcome:'SUCCESS'};
  const first=expect(await call(route,{method:'POST',token:flow.customerToken,
    headers:{'Idempotency-Key':key},body}),200,'first transfer result');
  const replay=expect(await call(route,{method:'POST',token:flow.customerToken,
    headers:{'Idempotency-Key':key},body}),200,'same result replay');
  assert.equal(first.paymentId,replay.paymentId);
  assert.equal(first.paymentStatus,'SUCCESS');
  const changed=await call(route,{method:'POST',token:flow.customerToken,
    headers:{'Idempotency-Key':key},body:{...body,outcome:'FAILED'}});
  assert.equal(changed.status,409);
  assert.equal(changed.body.errorCode,'IDEMPOTENCY_CONFLICT');
  const late=await call(route,{method:'POST',token:flow.customerToken,
    headers:{'Idempotency-Key':randomUUID()},body:{...body,outcome:'FAILED'}});
  assert.equal(late.status,409);
  assert.equal(late.body.errorCode,'PAYMENT_NOT_PENDING');
  assert.equal(expect(await call(`/v1/payments/${paid.paymentId}`,
    {token:flow.customerToken}),200,'paid state after late result').paymentStatus,'SUCCESS');
  const attempts=expect(await call(`/v1/payments/${paid.paymentId}/attempts?limit=20`,
    {token:flow.customerToken}),200,'attempt after replay');
  assert.equal(attempts.items.length,1);
  assert.equal(attempts.items[0].status,'SUCCESS');
  await notifications(flow.customerToken,[{type:'PAYMENT_SUCCESS',id:paid.paymentId}]);
  state.replayPaymentId=paid.paymentId;save();
  console.info('PASS Payment HTTP replay: concurrent same key, changed payload/key conflicts, one attempt, late failure denied, SUCCESS/Notification retained');
}
const phase=process.argv[2];
if(phase==='prepare') {
  const operatorSeed=JSON.parse(secret('operator_seed.json'));
  const operator=await login({email:operatorSeed.email,password:secret('operator_demo_password')});
  while(state.customers.length<5) await customer();
  while(state.drivers.length<5) await driver(operator,state.drivers.length);
  for(const entry of state.drivers) await fresh(entry);
  const customerToken=await login(state.customers[0]);
  const nearby=expect(await call('/v1/drivers/nearby?latitude=10.7769&longitude=106.7009&radiusKm=1&limit=100',
    {token:customerToken}),200,'nearby five Drivers');
  assert.ok(nearby.items.filter(item=>state.drivers.some(driver=>
    driver.driverId===item.driverId)).length>=5,
    'at least five fresh fixture Drivers are visible within 1 km');
  console.info('PASS opt-in fixtures: five new Customers and at least five approved MOTORBIKE Drivers; existing profiles untouched');
} else if(phase==='cash' || phase==='transfer') {
  const index=phase==='cash'?0:1;
  if(state.customers.length<5||state.drivers.length<5)
    throw new Error('Run opt-in prepare first');
  const flow=await assigned(state.customers[index]);
  if(phase==='cash') await cash(flow);else await transfer(flow);
} else if(phase==='post-trip-cash' || phase==='post-trip-transfer') {
  if(state.drivers.length<5) throw new Error('Run opt-in prepare first');
  for(const entry of state.drivers) {entry.latitude=10.7769;entry.longitude=106.7009;}
  save();
  await customer();
  const flow=await assigned(state.customers.at(-1));
  if(phase==='post-trip-cash') await postTripCash(flow);else await transfer(flow);
} else if(phase==='demo-availability') {
  const operatorSeed=JSON.parse(secret('operator_seed.json'));
  const operator=await login({email:operatorSeed.email,
    password:secret('operator_demo_password')});
  await driver(operator,state.drivers.length);
  const entry=state.drivers.at(-1),token=await login(entry);
  const before=expect(await call('/v1/drivers/me',{token}),200,'new Driver profile').driver;
  assert.equal(before.driverStatus,'OFFLINE');
  const online=expect(await call('/v1/drivers/me/availability',{method:'PUT',token,
    body:{driverStatus:'AVAILABLE',expectedVersion:before.version}}),200,
  'demo ONLINE without GPS request');
  assert.equal(online.driverStatus,'AVAILABLE');
  const nearby=expect(await call('/v1/drivers/nearby?latitude=10.7769&longitude=106.7009&radiusKm=1&limit=100',
    {token:operator}),200,'demo fixed location nearby');
  assert.ok(nearby.items.some(item=>item.driverId===entry.driverId),
    'new Driver appears at fixed demo pickup');
  const offline=expect(await call('/v1/drivers/me/availability',{method:'PUT',token,
    body:{driverStatus:'OFFLINE',expectedVersion:online.version}}),200,'demo OFFLINE');
  assert.equal(offline.driverStatus,'OFFLINE');
  assert.equal(expect(await call('/v1/drivers/me',{token}),200,'OFFLINE profile').driver.driverStatus,
    'OFFLINE');
  console.info('PASS demo availability: new approved Driver ONLINE without GPS request, fixed nearby point, OFFLINE');
} else if(phase==='resume-post-trip-cash') {
  const flow=await assigned(state.customers.at(-1));
  await resumePostTripCash(flow);
} else if(phase==='pages') {
  if(state.customers.length<5) throw new Error('Run opt-in prepare first');
  await pages();
} else if(phase==='nearby') {
  if(state.customers.length<5||state.drivers.length<5) throw new Error('Run opt-in prepare first');
  await nearby();
} else if(phase==='audit') {
  await audit();
} else if(phase==='failed-retry') {
  await failedRetry();
} else if(phase==='unpaid-cancel') {
  await unpaidCancel();
} else if(phase==='paid-cancel') {
  await paidCancel();
} else if(phase==='incident') {
  await incident();
} else if(phase==='resolve-incident') {
  await resolveIncident();
} else if(phase==='race') {
  await race();
} else if(phase==='rating') {
  await rating();
} else if(phase==='rating-read') {
  await ratingRead();
} else if(phase==='payment-replay') {
  await paymentReplay();
} else throw new Error('Usage: node dev/booking-http-e2e.mjs prepare|cash|transfer|post-trip-cash|post-trip-transfer|demo-availability|resume-post-trip-cash|pages|nearby|audit|failed-retry|unpaid-cancel|paid-cancel (legacy)|incident|resolve-incident|race|rating|rating-read|payment-replay');
