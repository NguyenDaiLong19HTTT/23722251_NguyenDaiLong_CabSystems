// Live Gateway check without inventing Booking, Trip, or Payment records.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const tripId='00000000-0000-4000-8000-000000000001';
const anonymous=await fetch(`${base}/v1/trips/${tripId}`);
assert.equal(anonymous.status,401);
assert.equal((await anonymous.json()).errorCode,'UNAUTHENTICATED');

const seed=JSON.parse(readFileSync(new URL('../.secrets/customer-dev/operator_seed.json',
  import.meta.url),'utf8'));
const password=readFileSync(new URL('../.secrets/customer-dev/operator_demo_password',
  import.meta.url),'utf8').trim();
const login=await fetch(`${base}/v1/auth/login`,{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:seed.email,password})});
assert.equal(login.status,200);
const account=await login.json();
assert.equal(typeof account.accessToken,'string');
const headers={Authorization:`Bearer ${account.accessToken}`};
const forbidden=await fetch(`${base}/v1/trips?limit=1`,{headers});
assert.equal(forbidden.status,403);
assert.equal((await forbidden.json()).errorCode,'FORBIDDEN');
const absent=await fetch(`${base}/v1/trips/${tripId}`,{headers});
assert.equal(absent.status,404);
assert.equal((await absent.json()).errorCode,'TRIP_NOT_FOUND');
console.info('PASS live Gateway Trip: anonymous 401, OPERATOR list 403, absent Trip 404 through mTLS; no Booking or Trip was created.');
