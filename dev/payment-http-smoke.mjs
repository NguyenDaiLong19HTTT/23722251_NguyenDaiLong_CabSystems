// Live Gateway checks that do not invent a Trip or Booking.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const seed=JSON.parse(readFileSync(new URL('../.secrets/customer-dev/operator_seed.json',
  import.meta.url),'utf8'));
const password=readFileSync(new URL('../.secrets/customer-dev/operator_demo_password',
  import.meta.url),'utf8').trim();
const trip='00000000-0000-4000-8000-000000000001';
const anonymous=await fetch(`${base}/v1/trips/${trip}/fare`);
assert.equal(anonymous.status,401);
const login=await fetch(`${base}/v1/auth/login`,{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:seed.email,password})});
assert.equal(login.status,200);
const account=await login.json();
const auth={Authorization:`Bearer ${account.accessToken}`};
const fare=await fetch(`${base}/v1/trips/${trip}/fare`,{headers:auth});
assert.equal(fare.status,503);
assert.equal((await fare.json()).errorCode,'SERVICE_UNAVAILABLE');
const attempts=await fetch(`${base}/v1/payments/${trip}/attempts?limit=1`,
  {headers:auth});
assert.equal(attempts.status,404);
assert.equal((await attempts.json()).errorCode,'PAYMENT_NOT_FOUND');
const create=await fetch(`${base}/v1/trips/${trip}/payments`,{method:'POST',
  headers:{...auth,'Content-Type':'application/json','Idempotency-Key':'payment-gate-check'},
  body:JSON.stringify({paymentMethod:'DEMO_TRANSFER'})});
assert.equal(create.status,503);
assert.equal((await create.json()).errorCode,'SERVICE_UNAVAILABLE');
console.info('PASS live Gateway: Payment anonymous 401; attempts unknown 404; verified caller cannot create/read Fare without Trip/Booking (503), no fake Payment created.');
