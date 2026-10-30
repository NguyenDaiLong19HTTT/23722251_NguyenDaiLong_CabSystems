// Opt-in demo fixture for Postman item 16. Registration/review use public APIs.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';

const base='http://127.0.0.1:33201';
const root=new URL('../.secrets/customer-dev/',import.meta.url);
const fixtureFile=new URL('nearby-demo/drivers.json',root);
const secret=name=>readFileSync(new URL(name,root),'utf8').trim();
const email='driver@example.test';
const password=secret('driver_question16_password');
const fixtures=JSON.parse(readFileSync(fixtureFile,'utf8'));
assert.ok(Array.isArray(fixtures)&&fixtures.length>=5&&fixtures.length<=6);
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
async function login(user,pass) {
  return expect(await call('/v1/auth/login',{method:'POST',body:{
    emailOrPhone:user,password:pass}}),200,'login').accessToken;
}
let known=fixtures.find(item=>item.email===email);
let driverToken;
let driverId;
if (known) {
  driverToken=await login(email,password);
  driverId=known.driverId;
} else {
  assert.equal(fixtures.length,5,'Demo GPS fixture already has six Drivers');
  const existing=await call('/v1/auth/login',{method:'POST',body:{emailOrPhone:email,password}});
  if(existing.status===200) throw new Error('Email exists outside the dedicated fixture; no changes made');
  assert.equal(existing.status,401,'Unexpected login response; no registration attempted');
  const operator=JSON.parse(secret('operator_seed.json'));
  const operatorToken=await login(operator.email,secret('operator_demo_password'));
  const phone='09'+String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0');
  const otp=expect(await call('/v1/auth/driver-registration/otp',{
    method:'POST',body:{phone}}),202,'request OTP');
  assert.ok(otp.challengeId&&otp.otp,'Demo OTP response is required');
  const verified=expect(await call('/v1/auth/driver-registration/otp/verify',{
    method:'POST',body:{challengeId:otp.challengeId,otp:otp.otp}}),200,'verify OTP');
  const submitted=await call('/v1/driver-applications',{method:'POST',body:{
    verificationToken:verified.verificationToken,
    fullName:'CAB Driver Postman 16',email,password,
    licenseNumber:`CAB-Q16-${randomBytes(6).toString('hex').toUpperCase()}`,
    vehicle:{plateNumber:`Q16-${randomBytes(5).toString('hex').toUpperCase()}`,
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
  driverId=created.driverId;
  driverToken=await login(email,password);
  const application=expect(await call(
    `/v1/operations/driver-applications/${created.applicationId}`,{
      token:operatorToken}),200,'application detail');
  const profile=expect(await call('/v1/drivers/me',{token:driverToken}),200,'Driver profile');
  const reviewed=expect(await call(
    `/v1/operations/driver-applications/${created.applicationId}/review`,{
      method:'POST',token:operatorToken,body:{expectedVersion:application.version,
        expectedDriverVersion:profile.driver.version,decision:'APPROVED'}}),200,'approve Driver');
  assert.equal(reviewed.application.status,'APPROVED');
}
const profile=expect(await call('/v1/drivers/me',{token:driverToken}),200,'current profile');
assert.equal(profile.driver.driverId,driverId);
assert.equal(profile.driver.approvalStatus,'APPROVED');
assert.equal(profile.vehicle.vehicleType,'MOTORBIKE');
assert.equal(profile.vehicle.vehicleStatus,'ACTIVE');
expect(await call('/v1/drivers/me/location',{method:'PUT',token:driverToken,
  body:{latitude:10.7769,longitude:106.7009,
    recordedAt:new Date(Date.now()-1000).toISOString()}}),200,'set location');
if(profile.driver.driverStatus!=='AVAILABLE') {
  expect(await call('/v1/drivers/me/availability',{method:'PUT',token:driverToken,
    body:{expectedVersion:profile.driver.version,driverStatus:'AVAILABLE'}}),
    200,'set AVAILABLE');
}
// Keep the five nearby demo Drivers eligible, but make the Postman Driver the
// closest when a new Booking is created at the documented demo pickup.
let fixtureChanged=false;
if(known&&(known.latitude!==10.7769||known.longitude!==106.7009)) {
  known.latitude=10.7769;
  known.longitude=106.7009;
  fixtureChanged=true;
}
for(const item of fixtures) if(item.driverId!==driverId&&
    item.latitude===10.7769&&item.longitude===106.7009) {
  item.latitude=10.7770;
  fixtureChanged=true;
}
if(!known) {
  fixtures.push({driverId,email,password,latitude:10.7769,longitude:106.7009});
  fixtureChanged=true;
}
if(fixtureChanged) {
  const pending=new URL('nearby-demo/drivers.json.pending',root);
  writeFileSync(pending,JSON.stringify(fixtures),{mode:0o600});
  renameSync(pending,fixtureFile);
}
const verified=expect(await call('/v1/drivers/me',{token:driverToken}),200,'verify ready');
assert.equal(verified.driver.driverStatus,'AVAILABLE');
console.log(`Driver ready for Postman item 16: ${driverId}`);
console.log('Credentials remain in local ignored storage and the user-provided login.');
