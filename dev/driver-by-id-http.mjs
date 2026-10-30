// Opt-in HTTP check against existing synthetic Booking fixtures. Reads only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const secret=name=>readFileSync(new URL('../.secrets/customer-dev/'+name,import.meta.url),'utf8').trim();
const state=JSON.parse(secret('booking_http_e2e.json'));
const booking=state.bookings.find(item=>item.tripId&&item.driverId&&
  state.customers.some(customer=>customer.customerId===item.customerId));
if(!booking||state.customers.length<2||state.drivers.length<2)
  throw new Error('Synthetic Booking/Trip fixtures missing; no user data will be changed');
const owner=state.customers.find(item=>item.customerId===booking.customerId);
const other=state.customers.find(item=>item.customerId!==booking.customerId&&
  !state.bookings.some(known=>known.customerId===item.customerId&&
    known.driverId===booking.driverId));
const driver=state.drivers.find(item=>item.driverId===booking.driverId);
const otherDriver=state.drivers.find(item=>item.driverId!==booking.driverId);
if(!other||!otherDriver) throw new Error('Independent synthetic principal missing');
const seed=JSON.parse(secret('operator_seed.json'));
const base='http://127.0.0.1:33201';
async function call(path,token,body) {
  const response=await fetch(base+path,{method:body?'POST':'GET',
    headers:{...(token?{Authorization:'Bearer '+token}:{}),
      ...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
}
async function login(email,password) {
  const response=await call('/v1/auth/login',undefined,{emailOrPhone:email,password});
  assert.equal(response.status,200,'fixture login');
  return response.body.accessToken;
}
const [ownerToken,otherToken,driverToken,otherDriverToken,operatorToken]=await Promise.all([
  login(owner.email,owner.password),login(other.email,other.password),
  login(driver.email,driver.password),login(otherDriver.email,otherDriver.password),
  login(seed.email,secret('operator_demo_password'))]);
const path='/v1/drivers/'+booking.driverId;
for(const token of [ownerToken,driverToken,operatorToken]) {
  const response=await call(path,token);
  assert.equal(response.status,200);
  assert.deepEqual(Object.keys(response.body).sort(),['driverId','fullName']);
  assert.equal(response.body.driverId,booking.driverId);
  assert.ok(response.body.fullName);
}
for(const token of [otherToken,otherDriverToken]) {
  const response=await call(path,token);
  assert.equal(response.status,404);
}
assert.equal((await call('/v1/drivers/00000000-0000-4000-8000-000000000001',
  operatorToken)).status,404);
assert.equal((await call('/v1/drivers/invalid',operatorToken)).status,400);
assert.equal((await call(path)).status,401);
assert.equal((await call(path,'invalid-token')).status,401);
console.info('PASS Driver by ID HTTP: owner Customer, own Driver and Operator 200; unrelated 404; missing 404; invalid ID 400; auth 401');
