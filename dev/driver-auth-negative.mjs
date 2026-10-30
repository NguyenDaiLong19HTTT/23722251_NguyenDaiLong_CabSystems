import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
const suffix=randomBytes(6).toString('hex'),password=randomBytes(24).toString('base64url')+'!';
const email=`driver-auth-${suffix}@example.test`;
const phone='09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
const recovery=randomBytes(32).toString('base64url');
const registered=await fetch(base+'/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json',
  'Idempotency-Key':randomUUID(),'Registration-Recovery-Token':recovery},
  body:JSON.stringify({fullName:'Authorization Customer',email,phone,password})});
let status=registered.status,result=await registered.json();
if (status===202) {
  for (let n=0;n<30;n++) {
    const response=await fetch(base+'/v1/auth/customer-registrations/'+encodeURIComponent(result.operationId),
      {headers:{'Registration-Recovery-Token':recovery}});
    assert.equal(response.status,200);
    const body=await response.json();
    if (body.status==='SUCCEEDED') {status=201;break;}
    if (body.status==='FAILED') throw new Error('Synthetic Customer registration failed');
    await new Promise(resolve=>setTimeout(resolve,200));
  }
}
assert.equal(status,201);
const login=await fetch(base+'/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:email,password})});
assert.equal(login.status,200);
const account=await login.json();assert.equal(account.account.role,'CUSTOMER');
const parts=account.accessToken.split('.');
assert.equal(parts.length,3,'JWT segments');
parts[2]=(parts[2].startsWith('A')?'B':'A')+parts[2].slice(1);
const tampered=parts.join('.');
assert.equal((await fetch(base+'/v1/accounts/me',{
  headers:{Authorization:'Bearer '+tampered}})).status,401,
  'modified JWT must not authenticate');
const headers={Authorization:'Bearer '+account.accessToken,'Content-Type':'application/json'};
assert.equal((await fetch(base+'/v1/drivers/me',{headers})).status,403);
assert.equal((await fetch(base+'/v1/drivers/me/location',{method:'PUT',headers,
  body:JSON.stringify({latitude:10,longitude:106,recordedAt:new Date().toISOString()})})).status,403);
assert.equal((await fetch(base+'/v1/drivers/me/availability',{method:'PUT',
  headers:{...headers,'Idempotency-Key':randomUUID()},
  body:JSON.stringify({expectedVersion:1,driverStatus:'OFFLINE'})})).status,403);
assert.equal((await fetch(base+'/v1/drivers/'+randomUUID(),{headers})).status,404);
const applicationId=randomUUID();
assert.equal((await fetch(base+'/v1/operations/driver-applications',{headers})).status,403);
assert.equal((await fetch(base+'/v1/operations/driver-applications/'+applicationId,{headers})).status,403);
assert.equal((await fetch(base+'/v1/operations/driver-applications/'+applicationId+'/review',{
  method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},
  body:JSON.stringify({expectedVersion:1,expectedDriverVersion:1,decision:'APPROVED'})})).status,403);
console.info('PASS modified JWT 401; CUSTOMER denied Driver read/location/availability and Admin list/detail/review');
