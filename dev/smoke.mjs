import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
const suffix=randomBytes(6).toString('hex');
const email=`demo-${suffix}@example.test`;
const phone='09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
const password=randomBytes(24).toString('base64url')+'!';
const key=randomUUID(),recovery=randomBytes(32).toString('base64url');
const body={fullName:'CAB Demo Customer',email,phone,password};
const headers={'Content-Type':'application/json','Idempotency-Key':key,
  'Registration-Recovery-Token':recovery};
async function request(path,options={}) {
  const response=await fetch(base+path,options);
  const data=await response.json();
  assert.equal(response.headers.get('cache-control'),'no-store');
  return {status:response.status,data};
}
let created=await request('/v1/auth/register',{method:'POST',headers,body:JSON.stringify(body)});
const registerStatus=created.status;
let operationId=created.status===202?created.data.operationId:undefined;
if (created.status===202) {
  for (let n=0;n<10;n++) {
    const current=await request('/v1/auth/customer-registrations/'+encodeURIComponent(operationId),{
      headers:{'Registration-Recovery-Token':recovery}});
    assert.equal(current.status,200);
    if (current.data.status==='SUCCEEDED') {created={status:201,data:current.data.result};break;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
}
assert.equal(created.status,201,`Registration did not complete (${created.data.errorCode ?? created.data.status ?? 'unknown'}: ${created.data.message ?? ''})`);
const account=created.data;
assert.equal(account.email,email);
if (!operationId) {
  // 201 intentionally omits operationId. Test-only DB lookup discovers this
  // synthetic operation so every run still exercises the public lookup route.
  const root=fileURLToPath(new URL('../',import.meta.url));
  const secret=readFileSync(join(root,'.secrets','customer-dev','identity_runtime_password'),'utf8').trim();
  const db=new pg.Client({connectionString:`postgresql://identity_runtime:${secret}@127.0.0.1:55439/cab_identity`,
    connectionTimeoutMillis:5000});
  await db.connect();
  try {
    const rows=await db.query('SELECT operation_id FROM registration_operation WHERE account_id=$1',
      [account.accountId]);
    assert.equal(rows.rowCount,1);
    operationId=rows.rows[0].operation_id;
  } finally {await db.end();}
}
const lookup=await request('/v1/auth/customer-registrations/'+encodeURIComponent(operationId),{
  headers:{'Registration-Recovery-Token':recovery}});
assert.equal(lookup.status,200,'Registration lookup did not succeed');
assert.equal(lookup.data.status,'SUCCEEDED');
assert.equal(lookup.data.result.accountId,account.accountId);
const login=await request('/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:email,password})});
assert.equal(login.status,200,'Login did not succeed');
assert.equal(login.data.account.accountId,account.accountId);
const auth={Authorization:'Bearer '+login.data.accessToken};
const me=await request('/v1/accounts/me',{headers:auth});
assert.equal(me.status,200,'GetMyAccount did not succeed');
assert.equal(me.data.accountId,account.accountId);
const customer=await request('/v1/customers/'+encodeURIComponent(account.customerId),{headers:auth});
assert.equal(customer.status,200,'GetCustomer did not succeed');
assert.equal(customer.data.customerId,account.customerId);
assert.equal(customer.data.accountStatus,me.data.accountStatus);
assert.equal(customer.data.createdAt,me.data.createdAt);
assert.equal(customer.data.updatedAt,me.data.updatedAt);
console.info(`PASS five HTTP endpoints via real Gateway, mTLS and dev PostgreSQL: `+
  `register ${registerStatus}, lookup ${lookup.status}, login ${login.status}, `+
  `me ${me.status}, customer ${customer.status}`);
