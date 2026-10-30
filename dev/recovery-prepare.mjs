import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const suffix=randomBytes(6).toString('hex');
const state={
  email:`recovery-${suffix}@example.test`,
  phone:'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0'),
  password:randomBytes(24).toString('base64url')+'!',
  key:randomUUID(),recovery:randomBytes(32).toString('base64url'),
};
const response=await fetch('http://127.0.0.1:33001/v1/auth/register',{
  method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':state.key,
    'Registration-Recovery-Token':state.recovery},
  body:JSON.stringify({fullName:'Recovery Customer',email:state.email,phone:state.phone,
    password:state.password}),
});
const data=await response.json();
assert.equal(response.status,202,'Customer outage must leave a durable PROCESSING operation');
assert.equal(data.status,'PROCESSING');
assert.equal(response.headers.get('cache-control'),'no-store');
state.operationId=data.operationId;
const caseName=process.env.CAB_RECOVERY_CASE??'customer';
if (!/^[a-z]{1,20}$/.test(caseName)) throw new Error('Invalid recovery test case');
const path=join(root,'.secrets','customer-dev',`recovery-${caseName}-state.json`);
writeFileSync(path,JSON.stringify(state),{flag:'wx',mode:0o600});
console.info('PASS Customer outage returns durable 202; synthetic retry state stored only in ignored local secret file');
