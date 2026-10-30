import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const tag=()=>randomBytes(7).toString('hex');
const phone=()=>'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
const password=()=>randomBytes(24).toString('base64url')+'!';
async function call(path,body,headers={}) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{
    ...(body?{'Content-Type':'application/json'}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),headers:response.headers};
}
async function finish(result) {
  assert.ok([201,202].includes(result.status),`Customer register status ${result.status}`);
  if(result.status===201)return result.data;
  const location=result.headers.get('location'),proof=result.headers.get('Registration-Recovery-Token');
  assert.ok(location&&proof);
  for(let attempt=0;attempt<20;attempt++) {
    const found=await call(location,undefined,{'Registration-Recovery-Token':proof});
    assert.equal(found.status,200);
    if(found.data.status==='SUCCEEDED')return found.data.result;
    assert.equal(found.data.status,'PROCESSING');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('Customer registration did not complete');
}
const number=phone(),pass=password(),email=`cab-phone-${tag()}@example.test`;
const account=await finish(await call('/v1/auth/register',
  {fullName:'CAB Phone Regression',email,phone:number,password:pass}));
assert.equal(account.phone,number);
for(const identifier of [email,number]) {
  const login=await call('/v1/auth/login',{emailOrPhone:identifier,password:pass});
  assert.equal(login.status,200,`Login status ${login.status}`);
  assert.equal(login.data.account.phone,number);
  const me=await call('/v1/accounts/me',undefined,{Authorization:`Bearer ${login.data.accessToken}`});
  assert.equal(me.status,200);assert.equal(me.data.phone,number);
  const profile=await call(`/v1/customers/${account.customerId}`,undefined,
    {Authorization:`Bearer ${login.data.accessToken}`});
  assert.equal(profile.status,200);assert.equal(profile.data.phone,number);
}
console.info('PASS new Customer domestic phone; email/phone login, Me and profile');

// Identity persists the canonical +84 form even for a new domestic request.
// Re-login and conflict checks exercise the same old-format lookup key.
const conflict=await call('/v1/auth/register',{fullName:'Conflict Check',
  email:`cab-conflict-${tag()}@example.test`,phone:number,password:password()});
assert.equal(conflict.status,409);assert.equal(conflict.data.errorCode,'CONTACT_CONFLICT');
console.info('PASS +84 canonical lookup via domestic login; equivalent registration CONTACT_CONFLICT');

for(const invalid of ['900000101','090000010','09000001011','09000a0101','1900000101','+84900000101']) {
  const registration=await call('/v1/auth/register',{fullName:'Invalid Phone',
    email:`invalid-${tag()}@example.test`,phone:invalid,password:password()});
  const otp=await call('/v1/auth/driver-registration/otp',{phone:invalid});
  const login=await call('/v1/auth/login',{emailOrPhone:invalid,password:pass});
  for(const response of [registration,otp,login]) {
    assert.equal(response.status,400);assert.equal(response.data.errorCode,'VALIDATION_ERROR');
  }
}
console.info('PASS six invalid phone forms rejected at Customer/OTP/login boundaries');

const driverPhone=phone();
const challenge=await call('/v1/auth/driver-registration/otp',{phone:driverPhone});
assert.equal(challenge.status,202);assert.match(challenge.data.otp??'',/^\d{6}$/);
const verified=await call('/v1/auth/driver-registration/otp/verify',
  {challengeId:challenge.data.challengeId,otp:challenge.data.otp});
assert.equal(verified.status,200);assert.equal(verified.data.verifiedPhone,driverPhone);
const suffix=tag();
const application=await call('/v1/driver-applications',{
  verificationToken:verified.data.verificationToken,fullName:'CAB Phone Driver',
  email:`cab-phone-driver-${suffix}@example.test`,password:password(),licenseNumber:`PHONE-${suffix}`,
  vehicle:{plateNumber:`PHONE-${suffix}`,vehicleType:'MOTORBIKE'}});
assert.ok([201,202].includes(application.status),`Driver submit status ${application.status}`);
console.info(`PASS Driver domestic phone OTP -> verify -> registration ${application.status}`);
