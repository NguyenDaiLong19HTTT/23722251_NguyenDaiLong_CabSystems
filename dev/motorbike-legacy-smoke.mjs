import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const fixture=JSON.parse(readFileSync(new URL('../.secrets/customer-dev/driver_seed.json',
  import.meta.url),'utf8'));
const password=readFileSync(new URL('../.secrets/customer-dev/driver_demo_password',
  import.meta.url),'utf8').trim();
const login=await fetch(`${base}/v1/auth/login`,{method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:fixture.email,password})});
assert.equal(login.status,200);
const accessToken=(await login.json()).accessToken;
const profile=await fetch(`${base}/v1/drivers/me`,{
  headers:{Authorization:`Bearer ${accessToken}`}});
assert.equal(profile.status,200);
const data=await profile.json();
assert.equal(data.driver?.driverId,fixture.driverId);
assert.equal(data.vehicle?.vehicleType,fixture.vehicleType);
console.info('PASS live Gateway: existing Driver vehicle type preserved and readable.');
