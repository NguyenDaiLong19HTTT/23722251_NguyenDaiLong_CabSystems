// One-time, opt-in fixture creation. All operations use public Gateway APIs.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';

const base='http://127.0.0.1:33201';
const root=new URL('../.secrets/customer-dev/',import.meta.url);
const directory=new URL('nearby-demo/',root);
const file=new URL('drivers.json',directory);
const secret=name=>readFileSync(new URL(name,root),'utf8').trim();
const saved=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];
assert.ok(Array.isArray(saved)&&saved.length<=6,'Invalid nearby demo fixture');
async function call(path,{method='GET',token,body,headers={}}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{ }),
    ...(body?{'Content-Type':'application/json'}:{ }),...headers},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.json()};
}
function expect(result,status,label) {
  assert.equal(result.status,status,`${label}: ${result.body?.errorCode??result.status}`);
  return result.body;
}
async function login(email,password) {
  return expect(await call('/v1/auth/login',{method:'POST',body:{
    emailOrPhone:email,password}}),200,'login').accessToken;
}
function save() {
  mkdirSync(directory,{recursive:true});
  const pending=new URL('drivers.json.pending',directory);
  writeFileSync(pending,JSON.stringify(saved),{mode:0o600});
  renameSync(pending,file);
}
const operator=JSON.parse(secret('operator_seed.json'));
const operatorToken=await login(operator.email,secret('operator_demo_password'));
for(let i=saved.length;i<5;i++) {
  const suffix=randomBytes(8).toString('hex');
  const email=`cab-nearby-${suffix}@example.test`;
  const phone='09'+String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0');
  const password=randomBytes(24).toString('base64url')+'!';
  const otp=expect(await call('/v1/auth/driver-registration/otp',{
    method:'POST',body:{phone}}),202,'request OTP');
  assert.ok(otp.challengeId&&otp.otp,'Demo OTP response is required');
  const verified=expect(await call('/v1/auth/driver-registration/otp/verify',{
    method:'POST',body:{challengeId:otp.challengeId,otp:otp.otp}}),200,'verify OTP');
  const submitted=await call('/v1/driver-applications',{method:'POST',body:{
    verificationToken:verified.verificationToken,
    fullName:`CAB Nearby Demo Driver ${i+1}`,email,password,
    licenseNumber:`CAB-NEAR-${randomBytes(6).toString('hex').toUpperCase()}`,
    vehicle:{plateNumber:`NEAR-${randomBytes(5).toString('hex').toUpperCase()}`,
      vehicleType:'MOTORBIKE'}}});
  let created=submitted.body;
  if(submitted.status===202) {
    for(let attempt=0;attempt<20;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,500));
      const status=await call(`/v1/driver-registration-operations/${created.operationId}`,{
        headers:{'Driver-Registration-Token':verified.verificationToken}});
      if(status.status===200&&status.body.status==='SUCCEEDED') {
        created=status.body.result;break;
      }
    }
  } else expect(submitted,201,'register Driver');
  assert.ok(created.driverId&&created.applicationId,'Driver registration incomplete');
  const driverToken=await login(email,password);
  const application=expect(await call(
    `/v1/operations/driver-applications/${created.applicationId}`,{
      token:operatorToken}),200,'application detail');
  const profile=expect(await call('/v1/drivers/me',{token:driverToken}),200,'Driver profile');
  const reviewed=expect(await call(
    `/v1/operations/driver-applications/${created.applicationId}/review`,{
      method:'POST',token:operatorToken,body:{expectedVersion:application.version,
        expectedDriverVersion:profile.driver.version,decision:'APPROVED'}}),200,'approve Driver');
  assert.equal(reviewed.application.status,'APPROVED');
  const latitude=10.7769+i*0.0002,longitude=106.7009;
  expect(await call('/v1/drivers/me/location',{method:'PUT',token:driverToken,
    body:{latitude,longitude,recordedAt:new Date(Date.now()-1000).toISOString()}}),
    200,'set location');
  const current=expect(await call('/v1/drivers/me',{token:driverToken}),200,'current Driver');
  expect(await call('/v1/drivers/me/availability',{method:'PUT',token:driverToken,
    body:{expectedVersion:current.driver.version,driverStatus:'AVAILABLE'}}),
    200,'set AVAILABLE');
  saved.push({driverId:created.driverId,email,password,latitude,longitude});
  save();
  console.log(`Prepared dedicated nearby Driver ${saved.length}/5`);
}
console.log('Five dedicated nearby Driver fixtures are ready; credentials remain in ignored local storage.');
