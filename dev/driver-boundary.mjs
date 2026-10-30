import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const seed=JSON.parse(readFileSync(join(folder,'driver_seed.json'),'utf8'));
const password=readFileSync(join(folder,'driver_demo_password'),'utf8').trim();
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
async function call(path,{method='GET',token,body,key}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:'Bearer '+token}:{}),
    ...(body?{'Content-Type':'application/json'}:{}),
    ...(key?{'Idempotency-Key':key}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
const login=await call('/v1/auth/login',{method:'POST',body:{emailOrPhone:seed.email,password}});
assert.equal(login.status,200);
const token=login.body.accessToken;
async function profile() {
  const value=await call('/v1/drivers/me',{token});
  assert.equal(value.status,200);
  return value.body.driver;
}
async function availability(driverStatus,expectedVersion,key=randomUUID()) {
  return call('/v1/drivers/me/availability',{method:'PUT',token,key,
    body:{driverStatus,expectedVersion}});
}
let driver=await profile();
if (driver.driverStatus==='AVAILABLE') {
  const off=await availability('OFFLINE',driver.version);
  assert.equal(off.status,200);
  driver=await profile();
}
const stale=await availability('AVAILABLE',driver.version);
assert.equal(stale.status,409,'stale or absent GPS cannot enable availability');
assert.equal(stale.body.errorCode,'LOCATION_STALE');
assert.equal((await profile()).version,driver.version,'rejected command cannot mutate Driver');

const location=await call('/v1/drivers/me/location',{method:'PUT',token,
  body:{latitude:10.7731,longitude:106.703,recordedAt:new Date(Date.now()-1000).toISOString()}});
assert.equal(location.status,200);
const key=randomUUID();
const enabled=await availability('AVAILABLE',driver.version,key);
assert.equal(enabled.status,200);
const conflict=await availability('OFFLINE',driver.version,key);
assert.equal(conflict.status,409,'same key with different payload must conflict');
assert.equal(conflict.body.errorCode,'IDEMPOTENCY_CONFLICT');
assert.equal((await profile()).driverStatus,'AVAILABLE');
const off=await availability('OFFLINE',enabled.body.version);
assert.equal(off.status,200);
console.info('PASS Driver boundary: stale GPS rejected without mutation, conflicting replay rejected, OFFLINE restored');
