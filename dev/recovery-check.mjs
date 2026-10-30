import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const caseName=process.env.CAB_RECOVERY_CASE??'customer';
if (!/^[a-z]{1,20}$/.test(caseName)) throw new Error('Invalid recovery test case');
const state=JSON.parse(readFileSync(join(root,'.secrets','customer-dev',
  `recovery-${caseName}-state.json`),'utf8'));
const base='http://127.0.0.1:33001';
let result;
for (let n=0;n<40;n++) {
  const response=await fetch(`${base}/v1/auth/customer-registrations/${encodeURIComponent(state.operationId)}`,
    {headers:{'Registration-Recovery-Token':state.recovery}});
  assert.equal(response.status,200);
  result=await response.json();
  if (result.status==='SUCCEEDED') break;
  await new Promise(resolve=>setTimeout(resolve,250));
}
assert.equal(result.status,'SUCCEEDED','Restarted Customer must allow durable recovery');
const replay=await fetch(base+'/v1/auth/register',{method:'POST',
  headers:{'Content-Type':'application/json','Idempotency-Key':state.key,
    'Registration-Recovery-Token':state.recovery},
  body:JSON.stringify({fullName:'Recovery Customer',email:state.email,phone:state.phone,
    password:state.password})});
assert.equal(replay.status,201);
assert.equal((await replay.json()).accountId,result.result.accountId);
console.info('PASS Customer restart recovers persisted 202 to SUCCEEDED and historical 201 replay');
