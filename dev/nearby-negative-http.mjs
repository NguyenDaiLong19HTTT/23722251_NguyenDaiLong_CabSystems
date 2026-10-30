// Opt-in: changes only one synthetic Driver, then restores fresh AVAILABLE.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const state=JSON.parse(readFileSync(new URL('../.secrets/customer-dev/booking_http_e2e.json',
  import.meta.url),'utf8'));
// The first synthetic Driver may be intentionally held by the ERROR fixture.
const candidate=state.drivers[4];
const customer=state.customers[0];
if(!candidate||!customer) throw new Error('Synthetic nearby fixtures missing');
const base='http://127.0.0.1:33201';
async function call(path,token,method='GET',body) {
  const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,
    ...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
}
async function login(entry) {
  const result=await call('/v1/auth/login','', 'POST',
    {emailOrPhone:entry.email,password:entry.password});
  assert.equal(result.status,200);
  return result.body.accessToken;
}
const driverToken=await login(candidate),customerToken=await login(customer);
async function profile() {
  const result=await call('/v1/drivers/me',driverToken);
  assert.equal(result.status,200);return result.body.driver;
}
async function location() {
  const result=await call('/v1/drivers/me/location',driverToken,'PUT',{
    latitude:candidate.latitude,longitude:candidate.longitude,
    recordedAt:new Date(Date.now()-1000).toISOString()});
  assert.equal(result.status,200);
}
async function availability(status) {
  const current=await profile();
  if(current.driverStatus===status) return;
  const result=await call('/v1/drivers/me/availability',driverToken,'PUT',
    {expectedVersion:current.version,driverStatus:status});
  assert.equal(result.status,200);
}
async function nearby(offsetMeters=0) {
  const lat=candidate.latitude+offsetMeters/111194.9266;
  const result=await call(`/v1/drivers/nearby?latitude=${lat}&longitude=${candidate.longitude}&radiusKm=1&limit=100`,
    customerToken);
  assert.equal(result.status,200);
  return result.body.items.some(item=>item.driverId===candidate.driverId);
}
try {
  await location();
  await availability('AVAILABLE');
  assert.equal(await nearby(999),true,'inside 1 km');
  assert.equal(await nearby(1001),false,'outside 1 km');
  await availability('OFFLINE');
  assert.equal(await nearby(),false,'OFFLINE excluded');
  await location();await availability('AVAILABLE');
  assert.equal(await nearby(),true,'fresh AVAILABLE included');
  await new Promise(resolve=>setTimeout(resolve,31_000));
  assert.equal(await nearby(),false,'stale GPS excluded');
  console.info('PASS nearby HTTP: 999 m included, 1001 m excluded, OFFLINE and stale GPS excluded');
} finally {
  await location();
  await availability('AVAILABLE');
}
