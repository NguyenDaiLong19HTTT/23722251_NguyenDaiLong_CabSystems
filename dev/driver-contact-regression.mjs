import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

const fixture=JSON.parse(readFileSync(new URL('../.secrets/customer-dev/driver_registration_smoke.json',import.meta.url),'utf8'));
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
const response=await fetch(base+'/v1/auth/register',{method:'POST',headers:{
  'Content-Type':'application/json','Idempotency-Key':randomUUID(),
  'Registration-Recovery-Token':randomBytes(32).toString('base64url')},
  body:JSON.stringify({fullName:'Contact collision probe',email:`collision-${randomUUID()}@example.test`,
    phone:fixture.phone,password:'ProbeOnlyPassword123!'})});
const body=await response.json();
assert.equal(response.status,409,'Customer registration must reject existing Driver contact');
assert.equal(body.errorCode,'CONTACT_CONFLICT');
console.info('PASS cross-role live contact collision: 409 CONTACT_CONFLICT');
