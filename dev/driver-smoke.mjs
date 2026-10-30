import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const data=JSON.parse(readFileSync(join(folder,'driver_seed.json'),'utf8'));
const password=readFileSync(join(folder,'driver_demo_password'),'utf8').trim();
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
const phase=process.argv[2]??'prepare';
async function request(path,{method='GET',headers={},body}={}) {
  const response=await fetch(base+path,{method,headers,
    ...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();
  assert.equal(response.headers.get('cache-control'),'no-store');
  return {status:response.status,result};
}
const login=await request('/v1/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:{emailOrPhone:data.email,password}});
assert.equal(login.status,200,'Driver login');
assert.equal(login.result.account.role,'DRIVER');
assert.equal(login.result.account.driverId,data.driverId);
const auth={Authorization:'Bearer '+login.result.accessToken};
const me=await request('/v1/accounts/me',{headers:auth});
assert.equal(me.status,200,'Driver Account');
assert.equal(me.result.driverId,data.driverId);
const profile=await request('/v1/drivers/me',{headers:auth});
assert.equal(profile.status,200,'Driver profile');
assert.equal(profile.result.driver.driverId,data.driverId);
assert.equal(profile.result.vehicle.vehicleId,data.vehicleId);
assert.equal(profile.result.vehicle.vehicleStatus,'ACTIVE');
assert.equal((await request('/v1/drivers/me')).status,401);
assert.equal((await request('/v1/drivers/me',{headers:{Authorization:'Bearer invalid'}})).status,401);
if (phase==='prepare') {
  const sample=await request('/v1/drivers/me/location',{method:'PUT',
    headers:{...auth,'Content-Type':'application/json'},
    body:{latitude:10.7731,longitude:106.703,recordedAt:new Date(Date.now()-1000).toISOString()}});
  assert.equal(sample.status,200,`Driver location: ${sample.result?.errorCode??'unknown'}`);
  assert.equal(sample.result.locationUpdated,true);
  const key=randomUUID(),body={expectedVersion:profile.result.driver.version,driverStatus:'AVAILABLE'};
  const h={...auth,'Content-Type':'application/json','Idempotency-Key':key};
  const available=await request('/v1/drivers/me/availability',{method:'PUT',headers:h,body});
  assert.equal(available.status,200,'Set AVAILABLE');
  assert.equal(available.result.driverStatus,'AVAILABLE');
  const replay=await request('/v1/drivers/me/availability',{method:'PUT',headers:h,body});
  assert.equal(replay.status,200,'Same command replay');
  assert.equal(replay.result.version,available.result.version);
  const read=await request('/v1/drivers/me',{headers:auth});
  assert.equal(read.result.driver.driverStatus,'AVAILABLE');
  assert.equal(read.result.driver.version,available.result.version);
  console.info('PASS Driver prepare: login/me/profile/vehicle, GPS, AVAILABLE, replay, auth denial');
} else if (phase==='check') {
  assert.equal(profile.result.driver.driverStatus,'AVAILABLE','AVAILABLE survived restart');
  const key=randomUUID(),body={expectedVersion:profile.result.driver.version,driverStatus:'OFFLINE'};
  const h={...auth,'Content-Type':'application/json','Idempotency-Key':key};
  const offline=await request('/v1/drivers/me/availability',{method:'PUT',headers:h,body});
  assert.equal(offline.status,200,'Set OFFLINE');
  assert.equal(offline.result.driverStatus,'OFFLINE');
  assert.equal((await request('/v1/drivers/me/availability',{method:'PUT',headers:h,body})).result.version,
    offline.result.version,'OFFLINE replay does not increment');
  const noChange=await request('/v1/drivers/me/availability',{method:'PUT',
    headers:{...auth,'Content-Type':'application/json','Idempotency-Key':randomUUID()},
    body:{expectedVersion:offline.result.version,driverStatus:'OFFLINE'}});
  assert.equal(noChange.status,200,'OFFLINE same-state new command');
  assert.equal(noChange.result.version,offline.result.version);
  console.info('PASS Driver check: persisted AVAILABLE after restart, OFFLINE/replay/no-op');
} else throw new Error('Use prepare or check');
