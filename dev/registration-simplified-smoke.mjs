import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const secretDir=join(root,'.secrets','customer-dev');
const outageFixture=join(secretDir,'customer_registration_outage_smoke.json');
const suffix=()=>randomBytes(8).toString('hex');
const phone=()=>'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
const password=()=>randomBytes(24).toString('base64url')+'!';

async function call(path,{method='GET',body,headers={}}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(body?{'Content-Type':'application/json'}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(response.headers.get('cache-control'),'no-store');
  return {status:response.status,data:await response.json(),headers:response.headers};
}

async function finishCustomer(response) {
  assert.ok([201,202].includes(response.status),`Customer registration ${response.status}: ${response.data.errorCode??''}`);
  if (response.status===201) return response.data;
  const id=response.data.operationId,proof=response.headers.get('Registration-Recovery-Token');
  assert.equal(response.data.status,'PROCESSING');
  assert.match(proof??'',/^[A-Za-z0-9_-]{43}$/);
  assert.ok(response.headers.get('location')?.endsWith(encodeURIComponent(id)));
  const noProof=await call(`/v1/auth/customer-registrations/${encodeURIComponent(id)}`);
  assert.equal(noProof.status,401);
  const wrong=await call(`/v1/auth/customer-registrations/${encodeURIComponent(id)}`,
    {headers:{'Registration-Recovery-Token':randomBytes(32).toString('base64url')}});
  assert.equal(wrong.status,404);
  for(let attempt=0;attempt<20;attempt++) {
    const found=await call(`/v1/auth/customer-registrations/${encodeURIComponent(id)}`,
      {headers:{'Registration-Recovery-Token':proof}});
    assert.equal(found.status,200);
    if(found.data.status==='SUCCEEDED')return found.data.result;
    assert.equal(found.data.status,'PROCESSING');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('Customer operation did not complete before bounded deadline');
}

async function customer() {
  const data={fullName:'CAB Regression Customer',email:`cab-reg-${suffix()}@example.test`,
    phone:phone(),password:password()};
  const first=await call('/v1/auth/register',{method:'POST',body:data});
  const account=await finishCustomer(first);
  assert.equal(account.email,data.email);
  const samePhone=await call('/v1/auth/register',{method:'POST',
    body:{...data,email:`cab-reg-${suffix()}@example.test`}});
  assert.equal(samePhone.status,409);assert.equal(samePhone.data.errorCode,'CONTACT_CONFLICT');
  const sameEmail=await call('/v1/auth/register',{method:'POST',body:{...data,phone:phone()}});
  assert.equal(sameEmail.status,409);assert.equal(sameEmail.data.errorCode,'CONTACT_CONFLICT');
  const raced={...data,email:`cab-race-${suffix()}@example.test`,phone:phone()};
  const pair=await Promise.all([0,1].map(()=>call('/v1/auth/register',{method:'POST',body:raced})));
  assert.equal(pair.filter(x=>x.status===409&&x.data.errorCode==='CONTACT_CONFLICT').length,1);
  assert.equal(pair.filter(x=>[201,202].includes(x.status)).length,1);
  await finishCustomer(pair.find(x=>[201,202].includes(x.status)));
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:data.email,password:data.password}});
  assert.equal(login.status,200);
  const auth={Authorization:`Bearer ${login.data.accessToken}`};
  const me=await call('/v1/accounts/me',{headers:auth});
  const profile=await call(`/v1/customers/${account.customerId}`,{headers:auth});
  assert.equal(me.status,200);assert.equal(profile.status,200);
  assert.equal(profile.data.accountId,account.accountId);
  console.info('PASS Customer no client key/proof, duplicate phone/email 409, concurrent one winner, login/Me/profile');
}

function otpFor(challengeId) {
  const read=name=>readFileSync(join(secretDir,name),'utf8').trim();
  const env={...process.env,CAB_DEV_OTP_ENABLED:'1',
    CAB_IDENTITY_RUNTIME_URL:`postgresql://identity_runtime:${read('identity_runtime_password')}@127.0.0.1:55439/cab_identity`};
  for(const purpose of ['contact','snapshot','lookup','idempotency','fingerprint','recovery',
    'refresh','receipt','jwt','otp','verification'])
    env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`]=join(secretDir,`identity_${purpose}_key`);
  return execFileSync(process.execPath,['services/identity-service/dist/otp-dev-read.js',challengeId],
    {cwd:root,env,encoding:'utf8',timeout:15000}).trim();
}

async function driver() {
  const data={phone:phone(),email:`cab-driver-reg-${suffix()}@example.test`,
    password:password(),licenseNumber:`TEST-${suffix()}`};
  const challenge=await call('/v1/auth/driver-registration/otp',
    {method:'POST',body:{phone:data.phone}});
  assert.equal(challenge.status,202);
  const verified=await call('/v1/auth/driver-registration/otp/verify',
    {method:'POST',body:{challengeId:challenge.data.challengeId,otp:otpFor(challenge.data.challengeId)}});
  assert.equal(verified.status,200);
  const body={verificationToken:verified.data.verificationToken,fullName:'CAB Regression Driver',
    email:data.email,password:data.password,licenseNumber:data.licenseNumber,
    vehicle:{plateNumber:`TEST-${suffix()}`,vehicleType:'MOTORBIKE'}};
  let submitted=await call('/v1/driver-applications',{method:'POST',body});
  assert.ok([201,202].includes(submitted.status),`Driver submit ${submitted.status}: ${submitted.data.errorCode??''}`);
  if(submitted.status===202) {
    const id=submitted.data.operationId;
    assert.equal((await call(`/v1/driver-registration-operations/${id}`)).status,401);
    assert.equal((await call(`/v1/driver-registration-operations/${id}`,
      {headers:{'Driver-Registration-Token':randomBytes(32).toString('base64url')}})).status,404);
    for(let attempt=0;attempt<20;attempt++) {
      const found=await call(`/v1/driver-registration-operations/${id}`,
        {headers:{'Driver-Registration-Token':body.verificationToken}});
      assert.equal(found.status,200);
      if(found.data.status==='SUCCEEDED') {submitted={status:201,data:found.data.result};break;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  assert.equal(submitted.status,201);
  assert.equal(submitted.data.approvalStatus,'PENDING_APPROVAL');
  // Test-only discovery of the opaque ID, which public 201 intentionally omits.
  const runtimePassword=readFileSync(join(secretDir,'identity_runtime_password'),'utf8').trim();
  const db=new pg.Client({connectionString:`postgresql://identity_runtime:${runtimePassword}@127.0.0.1:55439/cab_identity`,
    connectionTimeoutMillis:5000});
  await db.connect();
  let operationId;
  try {
    const rows=await db.query('SELECT operation_id FROM driver_registration WHERE application_id=$1',
      [submitted.data.applicationId]);
    assert.equal(rows.rowCount,1);
    operationId=rows.rows[0].operation_id;
  } finally {await db.end();}
  const proofOnly=await call(`/v1/driver-registration-operations/${operationId}`,
    {headers:{'Driver-Registration-Token':body.verificationToken}});
  assert.equal(proofOnly.status,200);
  assert.equal(proofOnly.data.status,'SUCCEEDED');
  assert.equal((await call(`/v1/driver-registration-operations/${operationId}`)).status,401);
  assert.equal((await call(`/v1/driver-registration-operations/${operationId}`,
    {headers:{'Driver-Registration-Token':randomBytes(32).toString('base64url')}})).status,404);
  const reused=await call('/v1/driver-applications',{method:'POST',body});
  assert.equal(reused.status,409);assert.equal(reused.data.errorCode,'VERIFICATION_TOKEN_USED');
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:data.email,password:data.password}});
  assert.equal(login.status,200);
  const application=await call('/v1/driver-applications/me',
    {headers:{Authorization:`Bearer ${login.data.accessToken}`}});
  assert.equal(application.status,200);assert.equal(application.data.status,'SUBMITTED');
  console.info('PASS Driver keyless submit, proof-only lookup/denials, consumed proof 409, login and own application');
}

async function outagePrepare() {
  const data={fullName:'CAB Outage Regression Customer',
    email:`cab-outage-${suffix()}@example.test`,phone:phone(),password:password()};
  const response=await call('/v1/auth/register',{method:'POST',body:data});
  assert.equal(response.status,202,'Customer outage must yield a durable operation');
  assert.equal(response.data.status,'PROCESSING');
  const proof=response.headers.get('Registration-Recovery-Token');
  assert.match(proof??'',/^[A-Za-z0-9_-]{43}$/);
  assert.ok(response.headers.get('location')?.endsWith(response.data.operationId));
  const path=`/v1/auth/customer-registrations/${response.data.operationId}`;
  assert.equal((await call(path)).status,401);
  assert.equal((await call(path,{headers:{'Registration-Recovery-Token':
    randomBytes(32).toString('base64url')}})).status,404);
  const found=await call(path,{headers:{'Registration-Recovery-Token':proof}});
  assert.equal(found.status,200);assert.equal(found.data.status,'PROCESSING');
  writeFileSync(outageFixture,JSON.stringify({operationId:response.data.operationId,proof}),
    {mode:0o600});
  console.info('PASS Customer outage: durable 202; server-issued proof authenticates lookup, absent/wrong proof denied');
}

async function outageCheck() {
  const {operationId,proof}=JSON.parse(readFileSync(outageFixture,'utf8'));
  for(let attempt=0;attempt<30;attempt++) {
    const found=await call(`/v1/auth/customer-registrations/${operationId}`,
      {headers:{'Registration-Recovery-Token':proof}});
    assert.equal(found.status,200);
    if(found.data.status==='SUCCEEDED') {
      assert.ok(found.data.result?.accountId&&found.data.result?.customerId);
      console.info('PASS Customer outage recovery: 202 PROCESSING to 200 SUCCEEDED with saved result');
      return;
    }
    assert.equal(found.data.status,'PROCESSING');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Customer outage operation did not recover before bounded deadline');
}


const mode=process.argv[2];
if(mode==='customer')await customer();
else if(mode==='driver')await driver();
else if(mode==='outage-prepare')await outagePrepare();
else if(mode==='outage-check')await outageCheck();
else throw Error('Use customer, driver, outage-prepare or outage-check');
