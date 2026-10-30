// Refresh only approved, AVAILABLE synthetic MOTORBIKE Drivers for manual nearby checks.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const fixture=JSON.parse(readFileSync(new URL('../.secrets/customer-dev/booking_http_e2e.json',import.meta.url),'utf8'));
const base='http://127.0.0.1:33201';
async function call(path,{token,method='GET',body}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{'Content-Type':'application/json'}),
    ...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  return {status:response.status,body:await response.json()};
}
async function login(person) {
  const response=await call('/v1/auth/login',{method:'POST',body:{
    emailOrPhone:person.email,password:person.password}});
  assert.equal(response.status,200,`fixture login: ${response.body.errorCode??response.status}`);
  return response.body.accessToken;
}

assert.ok(fixture.drivers.length>=5,'At least five separate synthetic Drivers are required');
assert.ok(fixture.customers.length>0,'A synthetic Customer is required');
const eligible=[];
for(const person of fixture.drivers) {
  const token=await login(person);
  const profile=await call('/v1/drivers/me',{token});
  assert.equal(profile.status,200,'fixture Driver profile');
  if(profile.body.driver.driverStatus!=='AVAILABLE'||
      profile.body.driver.approvalStatus!=='APPROVED'||
      profile.body.vehicle?.vehicleStatus!=='ACTIVE'||
      profile.body.vehicle?.vehicleType!=='MOTORBIKE') continue;
  eligible.push({person,token});
}
assert.ok(eligible.length>=3,'At least three eligible Drivers are required to show page 2');
for(const {person,token} of eligible) {
  const response=await call('/v1/drivers/me/location',{token,method:'PUT',body:{
    latitude:person.latitude,longitude:person.longitude,
    recordedAt:new Date(Date.now()-1000).toISOString()}});
  assert.equal(response.status,200,`GPS refresh: ${response.body.errorCode??response.status}`);
}
const customerToken=await login(fixture.customers[0]);
const seen=new Set();let cursor;
for(let page=0;page<30;page++) {
  const query=new URLSearchParams({latitude:'10.7769',longitude:'106.7009',
    radiusKm:'1',limit:'2'});
  if(cursor) query.set('cursor',cursor);
  const response=await call(`/v1/drivers/nearby?${query}`,{token:customerToken});
  assert.equal(response.status,200,`nearby page: ${response.body.errorCode??response.status}`);
  for(const item of response.body.items) seen.add(item.driverId);
  if(!response.body.hasMore) break;
  assert.ok(response.body.nextCursor,'Missing nextCursor');
  cursor=response.body.nextCursor;
}
assert.ok(eligible.every(({person})=>seen.has(person.driverId)),
  'An eligible synthetic Driver was missing from nearby');
console.log(`Ready for Postman now: ${fixture.drivers.length} synthetic Drivers, ${eligible.length} eligible and visible within 1 km. GPS expires from search eligibility after 30 seconds; rerun this command immediately before GET nearby.`);
