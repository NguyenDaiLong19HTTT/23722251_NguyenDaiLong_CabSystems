import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
const statePath=join(folder,'driver_registration_smoke.json');
const rejectPath=join(folder,'driver_registration_reject_smoke.json');
const racePath=join(folder,'driver_registration_race_smoke.json');
const read=name=>readFileSync(join(folder,name),'utf8').trim();
async function call(path,{method='GET',token,key,proof,body}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:'Bearer '+token}:{}),
    ...(key?{'Idempotency-Key':key}:{}),
    ...(proof?{'Driver-Registration-Token':proof}:{}),
    ...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json(),headers:response.headers};
}
function otpFor(challengeId) {
  const purposes=['contact','snapshot','lookup','idempotency','fingerprint','recovery',
    'refresh','receipt','jwt','otp','verification'];
  const env={...process.env,CAB_DEV_OTP_ENABLED:'1',
    CAB_IDENTITY_RUNTIME_URL:`postgresql://identity_runtime:${read('identity_runtime_password')}@`+
      `${process.env.CAB_DEMO_POSTGRES_HOST??'127.0.0.1'}:`+
      `${process.env.CAB_DEMO_POSTGRES_PORT??'55439'}/cab_identity`};
  for (const purpose of purposes)
    env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`]=join(folder,`identity_${purpose}_key`);
  return execFileSync(process.execPath,['services/identity-service/dist/otp-dev-read.js',challengeId],
    {cwd:root,env,encoding:'utf8',timeout:15000}).trim();
}
const phase=process.argv[2]??'prepare';
if (['prepare','prepare-reject','prepare-race'].includes(phase)) {
  const suffix=randomBytes(6).toString('hex');
  const fixture={phone:'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0'),
    email:`new-driver-${suffix}@example.test`,password:randomBytes(20).toString('base64url')+'!',
    licenseNumber:`LIC-${suffix.toUpperCase()}`,plateNumber:`TEST-${suffix.toUpperCase()}`};
  const requested=await call('/v1/auth/driver-registration/otp',{method:'POST',body:{phone:fixture.phone}});
  assert.equal(requested.status,202,'request OTP');
  const id=requested.body.challengeId;
  assert.ok(id);
  const wrong=await call('/v1/auth/driver-registration/otp/verify',{method:'POST',
    body:{challengeId:id,otp:'999999'}});
  assert.equal(wrong.status,400,'wrong OTP');
  assert.equal(wrong.body.errorCode,'OTP_INVALID_OR_EXPIRED');
  const code=otpFor(id);
  const verified=await call('/v1/auth/driver-registration/otp/verify',{method:'POST',
    body:{challengeId:id,otp:code}});
  assert.equal(verified.status,200,'verify OTP');
  assert.equal(verified.body.verifiedPhone,fixture.phone);
  const repeat=await call('/v1/auth/driver-registration/otp/verify',{method:'POST',
    body:{challengeId:id,otp:code}});
  assert.equal(repeat.status,409,'one verification per challenge');
  const key=randomUUID(),payload={verificationToken:verified.body.verificationToken,
    fullName:'Demo Applicant',email:fixture.email,password:fixture.password,
    licenseNumber:fixture.licenseNumber,
    vehicle:{plateNumber:fixture.plateNumber,vehicleType:'MOTORBIKE'}};
  let submitted=await call('/v1/driver-applications',{method:'POST',key,body:payload});
  assert.ok([201,202].includes(submitted.status),`submit ${submitted.status}: ${submitted.body.errorCode??''}`);
  if (submitted.status===202) {
    const operationId=submitted.body.operationId;
    for (let i=0;i<12;i++) {
      const found=await call('/v1/driver-registration-operations/'+operationId,{key,
        proof:payload.verificationToken});
      assert.equal(found.status,200,'lookup Driver registration');
      if (found.body.status==='SUCCEEDED') {submitted={status:201,body:found.body.result};break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  assert.equal(submitted.status,201,'Driver registration completed');
  assert.equal(submitted.body.approvalStatus,'PENDING_APPROVAL');
  const replay=await call('/v1/driver-applications',{method:'POST',key,body:payload});
  assert.equal(replay.status,201,'same registration replay');
  assert.equal(replay.body.driverId,submitted.body.driverId);
  const changed=await call('/v1/driver-applications',{method:'POST',key,
    body:{...payload,fullName:'Changed Applicant'}});
  assert.equal(changed.status,409,'same key/different payload');
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(login.status,200,'pending Driver may login');
  const token=login.body.accessToken;
  const own=await call('/v1/driver-applications/me',{token});
  assert.equal(own.status,200,'own application');
  assert.equal(own.body.status,'SUBMITTED');
  assert.equal(own.body.applicant.phone,fixture.phone,'verified phone is bound to submitted snapshot');
  const profile=await call('/v1/drivers/me',{token});
  assert.equal(profile.status,200,'pending Driver profile');
  assert.equal(profile.body.driver.approvalStatus,'PENDING_APPROVAL');
  const available=await call('/v1/drivers/me/availability',{method:'PUT',token,
    body:{expectedVersion:profile.body.driver.version,driverStatus:'AVAILABLE'}});
  assert.equal(available.status,409,'pending Driver cannot be AVAILABLE');
  fixture.accountId=submitted.body.accountId;fixture.driverId=submitted.body.driverId;
  fixture.applicationId=submitted.body.applicationId;
  const target=phase==='prepare-reject'?rejectPath:phase==='prepare-race'?racePath:statePath;
  writeFileSync(target,JSON.stringify(fixture),{flag:existsSync(target)?'w':'wx',mode:0o600});
  console.info('PASS Driver registration prepare: OTP wrong/right/reuse, durable pending, replay, login and unavailable');
} else if (phase==='review') {
  const fixture=JSON.parse(readFileSync(statePath,'utf8'));
  const operator=JSON.parse(read('operator_seed.json'));
  const adminLogin=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:operator.email,password:read('operator_demo_password')}});
  assert.equal(adminLogin.status,200,'Operator login');
  assert.equal(adminLogin.body.account.role,'OPERATOR');
  const admin=adminLogin.body.accessToken;
  const driverLogin=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(driverLogin.status,200);
  const token=driverLogin.body.accessToken;
  const deniedList=await call('/v1/operations/driver-applications',{token});
  assert.equal(deniedList.status,403,'Driver cannot list applications');
  assert.equal((await call('/v1/operations/driver-applications/'+fixture.applicationId,{token})).status,
    403,'Driver cannot read Admin detail');
  assert.equal((await call('/v1/operations/driver-applications/'+fixture.applicationId+'/review',
    {method:'POST',token,body:{expectedVersion:1,
      expectedDriverVersion:1,decision:'APPROVED'}})).status,403,
    'Driver cannot review an application');
  const list=await call('/v1/operations/driver-applications?status=SUBMITTED&limit=20',{token:admin});
  assert.equal(list.status,200,'Operator application list');
  assert.ok(list.body.items.some(item=>item.applicationId===fixture.applicationId));
  const detail=await call('/v1/operations/driver-applications/'+fixture.applicationId,{token:admin});
  assert.equal(detail.status,200,'Operator application detail');
  assert.equal(detail.body.applicant.phone,fixture.phone);
  const pending=await call('/v1/drivers/me',{token});
  assert.equal(pending.status,200);
  const body={expectedVersion:detail.body.version,
    expectedDriverVersion:pending.body.driver.version,decision:'APPROVED'};
  const wrongVersion=await call('/v1/operations/driver-applications/'+fixture.applicationId+'/review',
    {method:'POST',token:admin,body:{...body,expectedVersion:body.expectedVersion+1}});
  assert.equal(wrongVersion.status,409,'wrong review version');
  assert.equal(wrongVersion.body.errorCode,'VERSION_CONFLICT');
  const review=await call('/v1/operations/driver-applications/'+fixture.applicationId+'/review',
    {method:'POST',token:admin,body});
  assert.equal(review.status,200,`approve ${review.status}: ${review.body.errorCode??''}`);
  assert.equal(review.body.application.status,'APPROVED');
  assert.equal(review.body.driver.driverStatus,'OFFLINE');
  const repeat=await call('/v1/operations/driver-applications/'+fixture.applicationId+'/review',
    {method:'POST',token:admin,body});
  assert.equal(repeat.status,409,'second public review cannot commit again');
  assert.equal(repeat.body.errorCode,'APPLICATION_ALREADY_REVIEWED');
  const own=await call('/v1/driver-applications/me',{token});
  assert.equal(own.status,200);assert.equal(own.body.status,'APPROVED');
  const profile=await call('/v1/drivers/me',{token});
  assert.equal(profile.status,200);assert.equal(profile.body.driver.approvalStatus,'APPROVED');
  assert.equal(profile.body.vehicle.vehicleId,review.body.vehicle.vehicleId);
  const location=await call('/v1/drivers/me/location',{method:'PUT',token,
    body:{latitude:10.7731,longitude:106.703,recordedAt:new Date(Date.now()-1000).toISOString()}});
  assert.equal(location.status,200);
  const on=await call('/v1/drivers/me/availability',{method:'PUT',token,
    body:{expectedVersion:profile.body.driver.version,driverStatus:'AVAILABLE'}});
  assert.equal(on.status,200,'approved Driver AVAILABLE');
  const stale=await call('/v1/drivers/me/availability',{method:'PUT',token,
    body:{expectedVersion:profile.body.driver.version,driverStatus:'OFFLINE'}});
  assert.equal(stale.status,409);assert.equal(stale.body.errorCode,'VERSION_CONFLICT');
  const wrongRole=await call('/v1/drivers/me/availability',{method:'PUT',token:admin,
    body:{expectedVersion:on.body.version,driverStatus:'OFFLINE'}});
  assert.equal(wrongRole.status,403);
  const off=await call('/v1/drivers/me/availability',{method:'PUT',token,
    body:{expectedVersion:on.body.version,driverStatus:'OFFLINE'}});
  assert.equal(off.status,200,'approved Driver OFFLINE');
  console.info('PASS headerless APPROVED review and AVAILABLE/OFFLINE; wrong versions/roles denied');
} else if (phase==='reject') {
  const fixture=JSON.parse(readFileSync(rejectPath,'utf8'));
  const operator=JSON.parse(read('operator_seed.json'));
  const adminLogin=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:operator.email,password:read('operator_demo_password')}});
  assert.equal(adminLogin.status,200);
  const driverLogin=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(driverLogin.status,200);
  const admin=adminLogin.body.accessToken,token=driverLogin.body.accessToken;
  const detail=await call('/v1/operations/driver-applications/'+fixture.applicationId,{token:admin});
  assert.equal(detail.status,200);
  const profile=await call('/v1/drivers/me',{token});
  assert.equal(profile.status,200);
  const body={expectedVersion:detail.body.version,expectedDriverVersion:profile.body.driver.version,
    decision:'REJECTED',rejectionReason:'Demo: supplied details need correction'};
  const wrongVersion=await call('/v1/operations/driver-applications/'+fixture.applicationId+'/review',
    {method:'POST',token:admin,body:{...body,expectedDriverVersion:body.expectedDriverVersion+1}});
  assert.equal(wrongVersion.status,409);assert.equal(wrongVersion.body.errorCode,'VERSION_CONFLICT');
  const rejected=await call('/v1/operations/driver-applications/'+fixture.applicationId+'/review',
    {method:'POST',token:admin,body});
  assert.equal(rejected.status,200,`reject ${rejected.status}: ${rejected.body.errorCode??''}`);
  assert.equal(rejected.body.application.status,'REJECTED');
  const own=await call('/v1/driver-applications/me',{token});
  assert.equal(own.status,200);assert.equal(own.body.status,'REJECTED');
  assert.equal(own.body.rejectionReason,body.rejectionReason);
  const after=await call('/v1/drivers/me',{token});
  assert.equal(after.status,200);assert.equal(after.body.driver.approvalStatus,'REJECTED');
  assert.equal(after.body.driver.rejectionReason,body.rejectionReason);
  const location=await call('/v1/drivers/me/location',{method:'PUT',token,
    body:{latitude:10.7731,longitude:106.703,recordedAt:new Date(Date.now()-1000).toISOString()}});
  assert.equal(location.status,200);
  const on=await call('/v1/drivers/me/availability',{method:'PUT',token,
    body:{expectedVersion:after.body.driver.version,driverStatus:'AVAILABLE'}});
  assert.equal(on.status,409,'rejected Driver remains unavailable');
  console.info('PASS Driver rejection: Operator decision, own reason and fresh-GPS availability denial');
} else if (phase==='race') {
  const fixture=JSON.parse(readFileSync(racePath,'utf8'));
  const operator=JSON.parse(read('operator_seed.json'));
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:operator.email,password:read('operator_demo_password')}});
  assert.equal(login.status,200);
  const admin=login.body.accessToken;
  const detail=await call('/v1/operations/driver-applications/'+fixture.applicationId,{token:admin});
  assert.equal(detail.status,200);
  const driverLogin=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(driverLogin.status,200);
  const profile=await call('/v1/drivers/me',{token:driverLogin.body.accessToken});
  assert.equal(profile.status,200);
  const common={expectedVersion:detail.body.version,
    expectedDriverVersion:profile.body.driver.version};
  const path='/v1/operations/driver-applications/'+fixture.applicationId+'/review';
  const outcomes=await Promise.all([
    call(path,{method:'POST',token:admin,
      body:{...common,decision:'APPROVED'}}),
    call(path,{method:'POST',token:admin,
      body:{...common,decision:'REJECTED',rejectionReason:'Concurrent rejection'}}),
  ]);
  assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409],
    'exactly one competing review must commit');
  const final=await call(path.replace('/review',''),{token:admin});
  assert.equal(final.status,200);
  assert.equal(final.body.version,detail.body.version+1);
  assert.ok(['APPROVED','REJECTED'].includes(final.body.status));
  console.info('PASS Driver review race: one decision commits, one receives 409');
} else if (phase==='roles') {
  const fixture=JSON.parse(readFileSync(statePath,'utf8'));
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(login.status,200);
  const token=login.body.accessToken;
  assert.equal((await call('/v1/operations/driver-applications',{token})).status,403);
  assert.equal((await call('/v1/operations/driver-applications/'+fixture.applicationId,{token})).status,403);
  assert.equal((await call('/v1/operations/driver-applications/'+fixture.applicationId+'/review',
    {method:'POST',token,body:{expectedVersion:1,
      expectedDriverVersion:1,decision:'APPROVED'}})).status,403);
  console.info('PASS DRIVER denied Admin list/detail/review');
} else if (phase==='check') {
  const fixture=JSON.parse(readFileSync(statePath,'utf8'));
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:fixture.email,password:fixture.password}});
  assert.equal(login.status,200,'Driver login after restart');
  const own=await call('/v1/driver-applications/me',{token:login.body.accessToken});
  assert.equal(own.status,200,'Application survives restart');
  assert.equal(own.body.applicationId,fixture.applicationId);
  console.info(`PASS Driver registration check: ${own.body.status} persisted after restart`);
} else throw new Error('Use prepare or check');
