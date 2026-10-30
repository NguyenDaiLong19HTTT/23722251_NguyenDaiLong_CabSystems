import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=join(root,'.secrets','customer-dev');
const base='http://127.0.0.1:33201';
const json=name=>JSON.parse(readFileSync(join(dir,name),'utf8'));
const secret=name=>readFileSync(join(dir,name),'utf8').trim();
async function call(path,{method='GET',token,body,key}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{ }),
    ...(body?{'Content-Type':'application/json'}:{ }),
    ...(key?{'Idempotency-Key':key}:{ }),
  },...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
async function login(email,password) {
  const result=await call('/v1/auth/login',{method:'POST',body:{emailOrPhone:email,password}});
  assert.equal(result.status,200,'Existing credential login');
  return result.data.accessToken;
}
let customer;
for (const name of ['recovery-restart-state.json','recovery-test-state.json']) {
  const fixture=json(name);
  const result=await call('/v1/auth/login',{method:'POST',body:{emailOrPhone:fixture.email,
    password:fixture.password}});
  if (result.status===200) {customer=result.data;break;}
}
assert.ok(customer,'At least one existing Customer fixture must log in');
const customerMe=await call('/v1/accounts/me',{token:customer.accessToken});
assert.equal(customerMe.status,200);
const customerId=customerMe.data.customerId;
assert.ok(customerId);
const profile=await call(`/v1/customers/${encodeURIComponent(customerId)}`,
  {token:customer.accessToken});
assert.equal(profile.status,200);
assert.equal(profile.data.customerId,customerId);
const deniedCustomer=await call(`/v1/customers/${randomUUID()}`,
  {token:customer.accessToken});
assert.notEqual(deniedCustomer.status,200,'Cross-object Customer access denied');
console.info('PASS existing Customer login/Me/profile and cross-object denial');

const approved=json('driver_registration_smoke.json');
const rejected=json('driver_registration_reject_smoke.json');
const approvedToken=await login(approved.email,approved.password);
const rejectedToken=await login(rejected.email,rejected.password);
const approvedProfile=await call('/v1/drivers/me',{token:approvedToken});
const rejectedProfile=await call('/v1/drivers/me',{token:rejectedToken});
assert.equal(approvedProfile.status,200);assert.equal(rejectedProfile.status,200);
assert.equal(approvedProfile.data.driver.approvalStatus,'APPROVED');
assert.ok(approvedProfile.data.vehicle.vehicleId);
assert.equal(rejectedProfile.data.driver.approvalStatus,'REJECTED');
const rejectedApplication=await call('/v1/driver-applications/me',{token:rejectedToken});
assert.equal(rejectedApplication.status,200);
assert.equal(rejectedApplication.data.status,'REJECTED');
assert.ok(rejectedApplication.data.rejectionReason);
assert.equal(rejectedApplication.data.submittedVehicle.plateNumber,rejected.plateNumber);
const gps=await call('/v1/drivers/me/location',{method:'PUT',token:rejectedToken,
  body:{latitude:10.7731,longitude:106.703,recordedAt:new Date(Date.now()-1000).toISOString()}});
assert.equal(gps.status,200);
const available=await call('/v1/drivers/me/availability',{method:'PUT',token:rejectedToken,
  key:randomUUID(),body:{expectedVersion:rejectedProfile.data.driver.version,
    driverStatus:'AVAILABLE'}});
assert.equal(available.status,409,'Rejected Driver cannot become AVAILABLE with fresh GPS');
console.info('PASS existing approved/rejected Driver profiles, vehicle, reason and availability denial');

const operator=json('operator_seed.json');
const operatorToken=await login(operator.email,secret('operator_demo_password'));
const operatorMe=await call('/v1/accounts/me',{token:operatorToken});
assert.equal(operatorMe.status,200);
assert.equal(operatorMe.data.role,'OPERATOR');
console.info('PASS existing Operator login/Me');

const own=await call('/v1/notifications?limit=100',{token:approvedToken});
assert.equal(own.status,200);
assert.ok(Array.isArray(own.data.items));
const notice=own.data.items[0];
if (notice) {
  const read=await call(`/v1/notifications/${notice.notificationId}/read`,
    {method:'PATCH',token:approvedToken});
  assert.equal(read.status,200);assert.equal(read.data.isRead,true);
  const other=await call(`/v1/notifications/${notice.notificationId}/read`,
    {method:'PATCH',token:rejectedToken});
  assert.equal(other.status,404);
}
console.info('PASS existing Notification own list (including empty protobuf list)');
