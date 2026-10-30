import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const base='http://127.0.0.1:33001';
const uuid=()=>randomUUID();
const token=()=>randomBytes(32).toString('base64url');
const suffix=randomBytes(6).toString('hex');
const email=`scenario-${suffix}@example.test`;
const phone='09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
const password=token()+'!';
const body={fullName:'Scenario Customer',email,phone,password};
const key=uuid(),recovery=token();
const headers={'Content-Type':'application/json','Idempotency-Key':key,
  'Registration-Recovery-Token':recovery};
async function http(path,options={}) {
  const response=await fetch(base+path,options);
  const data=await response.json();
  assert.equal(response.headers.get('cache-control'),'no-store');
  return {status:response.status,data};
}
const post=(data,h=headers)=>http('/v1/auth/register',{method:'POST',headers:h,body:JSON.stringify(data)});
async function terminal(result,secret) {
  if (result.status===201) return result.data;
  assert.equal(result.status,202);
  for (let n=0;n<20;n++) {
    const lookup=await http(`/v1/auth/customer-registrations/${encodeURIComponent(result.data.operationId)}`,
      {headers:{'Registration-Recovery-Token':secret}});
    assert.equal(lookup.status,200);
    if (lookup.data.status==='SUCCEEDED') return lookup.data.result;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Registration stayed PROCESSING');
}
const first=await terminal(await post(body),recovery);
assert.equal(first.email,email);
const replay=await terminal(await post(body),recovery);
assert.equal(replay.accountId,first.accountId);
assert.deepEqual((await post({...body,fullName:'Different'})).status,409);
assert.equal((await post(body,{...headers,'Registration-Recovery-Token':token()})).status,401);
assert.equal((await post(body,{...headers,'Idempotency-Key':uuid(),
  'Registration-Recovery-Token':token()})).status,409);
const raceSuffix=randomBytes(6).toString('hex');
const raceBody={...body,email:`race-${raceSuffix}@example.test`,
  phone:'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0')};
const raceHeaders=[0,1].map(()=>({...headers,'Idempotency-Key':uuid(),
  'Registration-Recovery-Token':token()}));
const race=await Promise.all(raceHeaders.map(h=>post(raceBody,h)));
assert.deepEqual(race.map(r=>r.status).sort((a,b)=>a-b).map(code=>code===202?201:code),[201,409]);
const winner=race.find(r=>r.status!==409);
assert.ok(winner);
const raceAccount=await terminal(winner,raceHeaders[race.indexOf(winner)]['Registration-Recovery-Token']);
assert.equal(raceAccount.email,raceBody.email);
assert.equal((await http('/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:email,password:'wrong'})})).status,401);
const login=await http('/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:email,password})});
assert.equal(login.status,200);
const auth={Authorization:'Bearer '+login.data.accessToken};
assert.equal((await http('/v1/accounts/me',{headers:auth})).status,200);
assert.equal((await http('/v1/accounts/me')).status,401);

// Own synthetic account and session only; no user database or shared resource.
const runtimePassword=readFileSync(join(root,'.secrets','customer-dev','identity_runtime_password'),'utf8').trim();
const db=new pg.Client({connectionString:`postgresql://identity_runtime:${runtimePassword}@127.0.0.1:55439/cab_identity`});
await db.connect();
try {
  const segment=login.data.accessToken.split('.')[1];
  const claims=JSON.parse(Buffer.from(segment,'base64url').toString('utf8'));
  assert.equal(claims.sub,first.accountId);
  await db.query('UPDATE session SET revoked_at=now(),version=version+1 WHERE session_id=$1',[claims.sid]);
  assert.equal((await http('/v1/accounts/me',{headers:auth})).status,401);
  await db.query("UPDATE account SET account_status='SUSPENDED' WHERE account_id=$1",[first.accountId]);
  assert.equal((await http('/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({emailOrPhone:email,password})})).status,403);
} finally {await db.end();}
console.info('PASS real replay/conflict/password/Session revoke/Account lock on two dev DBs and mTLS');
