import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'.secrets','customer-dev');
const file=join(dir,'driver_registration_recovery.json');
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
const read=name=>readFileSync(join(dir,name),'utf8').trim();
async function call(path,{method='GET',body,key,proof,token}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(body?{'Content-Type':'application/json'}:{}),
    ...(key?{'Idempotency-Key':key}:{}),
    ...(proof?{'Driver-Registration-Token':proof}:{}),
    ...(token?{Authorization:'Bearer '+token}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
function otp(id) {
  const env={...process.env,CAB_DEV_OTP_ENABLED:'1',
    CAB_IDENTITY_RUNTIME_URL:`postgresql://identity_runtime:${read('identity_runtime_password')}@127.0.0.1:55439/cab_identity`};
  for (const purpose of ['contact','snapshot','lookup','idempotency','fingerprint','recovery',
    'refresh','receipt','jwt','otp','verification'])
    env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`]=join(dir,`identity_${purpose}_key`);
  return execFileSync(process.execPath,['services/identity-service/dist/otp-dev-read.js',id],
    {cwd:root,env,encoding:'utf8',timeout:15000}).trim();
}
const phase=process.argv[2];
if (phase==='prepare') {
  const suffix=randomBytes(6).toString('hex');
  const fixture={email:`driver-recovery-${suffix}@example.test`,
    phone:'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0'),
    password:randomBytes(20).toString('base64url')+'!',key:randomUUID()};
  const challenge=await call('/v1/auth/driver-registration/otp',{method:'POST',
    body:{phone:fixture.phone}});
  assert.equal(challenge.status,202);
  const proof=await call('/v1/auth/driver-registration/otp/verify',{method:'POST',
    body:{challengeId:challenge.body.challengeId,otp:otp(challenge.body.challengeId)}});
  assert.equal(proof.status,200);
  fixture.proof=proof.body.verificationToken;
  fixture.payload={verificationToken:fixture.proof,fullName:'Recovery Driver',
    email:fixture.email,password:fixture.password,licenseNumber:`REC-${suffix}`,
    vehicle:{plateNumber:`REC-${suffix}`,vehicleType:'MOTORBIKE'}};
  const submitted=await call('/v1/driver-applications',{method:'POST',key:fixture.key,
    body:fixture.payload});
  assert.equal(submitted.status,202,'Driver outage must yield durable PROCESSING');
  assert.equal(submitted.body.status,'PROCESSING');
  fixture.operationId=submitted.body.operationId;
  const replay=await call('/v1/driver-applications',{method:'POST',key:fixture.key,
    body:fixture.payload});
  assert.equal(replay.status,202,'same request remains same operation');
  assert.equal(replay.body.operationId,fixture.operationId);
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(login.status,409,'incomplete Account cannot login');
  writeFileSync(file,JSON.stringify(fixture),{mode:0o600});
  console.info('PASS Driver outage prepare: 202 durable operation, replay same ID, login blocked');
} else if (phase==='check') {
  const fixture=JSON.parse(readFileSync(file,'utf8'));
  let operation;
  const until=Date.now()+30000;
  do {
    const found=await call('/v1/driver-registration-operations/'+fixture.operationId,
      {key:fixture.key,proof:fixture.proof});
    assert.equal(found.status,200);
    operation=found.body;
    if (operation.status==='SUCCEEDED') break;
    await new Promise(resolve=>setTimeout(resolve,500));
  } while (Date.now()<until);
  assert.equal(operation.status,'SUCCEEDED','recovery worker finalized after Driver restart');
  const replay=await call('/v1/driver-applications',{method:'POST',key:fixture.key,
    body:fixture.payload});
  assert.equal(replay.status,201);
  assert.equal(replay.body.driverId,operation.result.driverId);
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(login.status,200);
  const app=await call('/v1/driver-applications/me',{token:login.body.accessToken});
  assert.equal(app.status,200);assert.equal(app.body.status,'SUBMITTED');
  console.info('PASS Driver outage recovery: PROCESSING→SUCCEEDED after restart, replay201, login and pending application');
} else throw new Error('Use prepare or check');
