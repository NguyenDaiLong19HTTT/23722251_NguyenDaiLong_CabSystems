import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Temporary Compose one-offs exercise the new image and real services while
// preserving the old demo containers for docker start in finally.
const root=fileURLToPath(new URL('../',import.meta.url));
const docker=process.env.CAB_DEV_DOCKER??
  join(process.env.LOCALAPPDATA??'','Programs','DockerDesktop','resources','bin','docker.exe');
const base='http://127.0.0.1:33201';
const names={identity:'cab-headerless-identity-test',driver:'cab-headerless-driver-test',
  gateway:'cab-headerless-gateway-test'};
const old=['cab-api-gateway-1','cab-driver-service-1','cab-identity-service-1'];
const live=process.argv.includes('--live');
const created=[],stopped=[];
const tag=()=>randomBytes(7).toString('hex');
const phone=()=>'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
const password=()=>randomBytes(24).toString('base64url')+'!';
function cmd(...args) {
  return execFileSync(docker,args,{cwd:root,encoding:'utf8',timeout:120000,
    windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
}
function inspect(name) {return JSON.parse(cmd('inspect',name))[0];}
async function ready(name) {
  for(let i=0;i<40;i++) {
    const state=inspect(name).State;
    if(state.Health?.Status==='healthy')return;
    if(!state.Running||state.Health?.Status==='unhealthy')
      throw Error(`${name} did not become healthy`);
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw Error(`${name} readiness deadline`);
}
async function call(path,{method='GET',body,token,proof,recovery}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{ }),
    ...(proof?{'Driver-Registration-Token':proof}:{}),
    ...(recovery?{'Registration-Recovery-Token':recovery}:{}),
    ...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),headers:response.headers};
}
async function applicant() {
  const id=tag(),number=phone(),pass=password(),email=`cab-no-key-${id}@example.test`;
  const otp=await call('/v1/auth/driver-registration/otp',
    {method:'POST',body:{phone:number}});
  assert.equal(otp.status,202,'OTP request');assert.match(otp.data.otp??'',/^\d{6}$/);
  const proof=await call('/v1/auth/driver-registration/otp/verify',{method:'POST',
    body:{challengeId:otp.data.challengeId,otp:otp.data.otp}});
  assert.equal(proof.status,200,'OTP verify');assert.equal(proof.data.verifiedPhone,number);
  let submit=await call('/v1/driver-applications',{method:'POST',body:{
    verificationToken:proof.data.verificationToken,fullName:'CAB Headerless Test',
    email,password:pass,licenseNumber:`NOKEY-${id}`,
    vehicle:{plateNumber:`NOKEY-${id}`,vehicleType:'MOTORBIKE'}}});
  assert.ok([201,202].includes(submit.status),`Driver submit ${submit.status}`);
  if(submit.status===202) {
    for(let i=0;i<20;i++) {
      const found=await call(`/v1/driver-registration-operations/${submit.data.operationId}`,
        {proof:proof.data.verificationToken});
      assert.equal(found.status,200);
      if(found.data.status==='SUCCEEDED') {submit={status:201,data:found.data.result};break;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  assert.equal(submit.status,201,'Driver registration completed');
  const login=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:email,password:pass}});
  assert.equal(login.status,200,'Driver login');
  return {token:login.data.accessToken,applicationId:submit.data.applicationId,
    driverId:submit.data.driverId,number};
}
async function review(candidate,admin,decision) {
  const path=`/v1/operations/driver-applications/${candidate.applicationId}`;
  const detail=await call(path,{token:admin});assert.equal(detail.status,200);
  assert.equal(detail.data.applicant.phone,candidate.number);
  const profile=await call('/v1/drivers/me',{token:candidate.token});
  assert.equal(profile.status,200);
  const body={expectedVersion:detail.data.version,
    expectedDriverVersion:profile.data.driver.version,decision,
    ...(decision==='REJECTED'?{rejectionReason:'Test-only rejection'}:{})};
  const denied=await call(`${path}/review`,{method:'POST',token:candidate.token,body});
  assert.equal(denied.status,403,'Driver role cannot review');
  const wrong=await call(`${path}/review`,{method:'POST',token:admin,
    body:{...body,expectedDriverVersion:body.expectedDriverVersion+1}});
  assert.equal(wrong.status,409);assert.equal(wrong.data.errorCode,'VERSION_CONFLICT');
  const result=await call(`${path}/review`,{method:'POST',token:admin,body});
  assert.equal(result.status,200,`${decision} review without header`);
  assert.equal(result.data.application.status,decision);
  const again=await call(`${path}/review`,{method:'POST',token:admin,body});
  assert.equal(again.status,409);assert.equal(again.data.errorCode,'APPLICATION_ALREADY_REVIEWED');
  return result.data;
}
async function customerFlow() {
  const id=tag(),number=phone(),pass=password(),email=`cab-phone-${id}@example.test`;
  const body={fullName:'CAB Phone Test',email,phone:number,password:pass};
  let registered=await call('/v1/auth/register',{method:'POST',body});
  assert.ok([201,202].includes(registered.status),`Customer register ${registered.status}`);
  if(registered.status===202) {
    const recovery=registered.headers.get('Registration-Recovery-Token');
    assert.match(recovery??'',/^[A-Za-z0-9_-]{43}$/);
    for(let i=0;i<20;i++) {
      const lookup=await call(`/v1/auth/customer-registrations/${registered.data.operationId}`,
        {recovery});
      assert.equal(lookup.status,200);
      if(lookup.data.status==='SUCCEEDED') {
        registered={status:201,data:lookup.data.result};break;
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  assert.equal(registered.status,201,'Customer registration completed');
  assert.equal(registered.data.phone,number);
  const duplicate=await call('/v1/auth/register',{method:'POST',
    body:{...body,email:`cab-phone-duplicate-${id}@example.test`}});
  assert.equal(duplicate.status,409);assert.equal(duplicate.data.errorCode,'CONTACT_CONFLICT');
  for(const input of [email,number]) {
    const login=await call('/v1/auth/login',{method:'POST',
      body:{emailOrPhone:input,password:pass}});
    assert.equal(login.status,200,`Customer login ${input===email?'email':'phone'}`);
    assert.equal(login.data.account.phone,number);
    const me=await call('/v1/accounts/me',{token:login.data.accessToken});
    assert.equal(me.status,200);assert.equal(me.data.phone,number);
    const profile=await call(`/v1/customers/${registered.data.customerId}`,
      {token:login.data.accessToken});
    assert.equal(profile.status,200);assert.equal(profile.data.phone,number);
  }
  for(const invalid of ['900000101','090000010','09000001011','09000a0101',
    '1900000101','+84900000101']) {
    const rejected=await call('/v1/auth/driver-registration/otp',
      {method:'POST',body:{phone:invalid}});
    assert.equal(rejected.status,400,`invalid phone ${invalid}`);
    const register=await call('/v1/auth/register',{method:'POST',
      body:{...body,phone:invalid}});
    assert.equal(register.status,400,`invalid Customer phone ${invalid}`);
    const login=await call('/v1/auth/login',{method:'POST',
      body:{emailOrPhone:invalid,password:pass}});
    assert.equal(login.status,400,`invalid phone login ${invalid}`);
  }
  console.info('PASS domestic Customer registration/read/email+phone login, duplicate and invalid input');
}
async function run() {
  for(const name of old) {
    const state=inspect(name);
    assert.equal(state.Config.Labels['com.docker.compose.project'],'cab');
    assert.equal(state.State.Running,true,`${name} must already be running`);
  }
  if(!live) for(const name of Object.values(names)) {
    let found=false;
    try {inspect(name);found=true;} catch {/* Expected absent test container. */}
    assert.equal(found,false,`${name} already exists`);
  }
  const folder=join(root,'.secrets','customer-dev');
  const operator=JSON.parse(readFileSync(join(folder,'operator_seed.json'),'utf8'));
  const operatorPassword=readFileSync(join(folder,'operator_demo_password'),'utf8').trim();
  if(!live) {
    console.info('Stopping only three app containers for candidate network checks');
    for(const name of old) {cmd('stop',name);stopped.push(name);}
    for(const [service,name] of [['identity-service',names.identity],
      ['driver-service',names.driver],['api-gateway',names.gateway]]) {
      const args=['compose','run','-d','--no-deps','--use-aliases','--name',name];
      if(service==='api-gateway')args.push('-p','127.0.0.1:33201:33201');
      cmd(...args,service);created.push(name);await ready(name);
    }
  }
  const operatorLogin=await call('/v1/auth/login',{method:'POST',
    body:{emailOrPhone:operator.email,password:operatorPassword}});
  assert.equal(operatorLogin.status,200,'Legacy Operator email login on candidate');
  assert.match(operator.phone,/^\+84[0-9]{10}$/);
  assert.equal(operatorLogin.data.account.phone,operator.phone,
    'Overlength legacy phone is preserved exactly');
  const admin=operatorLogin.data.accessToken;
  const operatorMe=await call('/v1/accounts/me',{token:admin});
  assert.equal(operatorMe.status,200);assert.equal(operatorMe.data.phone,operator.phone);
  console.info('PASS legacy overlength Operator email login and unchanged read response');
  await customerFlow();
  const approved=await applicant();
  await review(approved,admin,'APPROVED');
  const profile=await call('/v1/drivers/me',{token:approved.token});
  assert.equal(profile.status,200);assert.equal(profile.data.driver.approvalStatus,'APPROVED');
  const gps=await call('/v1/drivers/me/location',{method:'PUT',token:approved.token,
    body:{latitude:10.7731,longitude:106.703,
      recordedAt:new Date(Date.now()-1000).toISOString()}});
  assert.equal(gps.status,200);
  const on=await call('/v1/drivers/me/availability',{method:'PUT',token:approved.token,
    body:{driverStatus:'AVAILABLE',expectedVersion:profile.data.driver.version}});
  assert.equal(on.status,200,'AVAILABLE without header');
  const stale=await call('/v1/drivers/me/availability',{method:'PUT',token:approved.token,
    body:{driverStatus:'OFFLINE',expectedVersion:profile.data.driver.version}});
  assert.equal(stale.status,409);assert.equal(stale.data.errorCode,'VERSION_CONFLICT');
  const wrongRole=await call('/v1/drivers/me/availability',{method:'PUT',token:admin,
    body:{driverStatus:'OFFLINE',expectedVersion:on.data.version}});
  assert.equal(wrongRole.status,403);
  const off=await call('/v1/drivers/me/availability',{method:'PUT',token:approved.token,
    body:{driverStatus:'OFFLINE',expectedVersion:on.data.version}});
  assert.equal(off.status,200,'OFFLINE without header');
  console.info('PASS APPROVED review and AVAILABLE/OFFLINE without header; version/role denied');
  const rejected=await applicant();
  await review(rejected,admin,'REJECTED');
  const rejectedProfile=await call('/v1/drivers/me',{token:rejected.token});
  assert.equal(rejectedProfile.data.driver.approvalStatus,'REJECTED');
  const rejectedOn=await call('/v1/drivers/me/availability',{method:'PUT',token:rejected.token,
    body:{driverStatus:'AVAILABLE',expectedVersion:rejectedProfile.data.driver.version}});
  assert.equal(rejectedOn.status,409);assert.equal(rejectedOn.data.errorCode,'DRIVER_NOT_ELIGIBLE');
  console.info('PASS REJECTED review without header; rejected Driver cannot become AVAILABLE');
}
try {await run();}
finally {
  for(const name of created.reverse()) {
    try {cmd('stop',name);} catch {console.error(`Could not stop ${name}`);}
    try {cmd('rm',name);} catch {console.error(`Could not remove test container ${name}`);}
  }
  for(const name of stopped.reverse()) {
    try {cmd('start',name);await ready(name);}
    catch {console.error(`Could not restore ${name}`);}
  }
  if(!live) console.info('Original Compose app containers restored; PostgreSQL/volumes were untouched');
}
