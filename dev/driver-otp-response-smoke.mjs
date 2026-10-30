import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const dir=join(root,'.secrets','customer-dev');
const phone=()=>'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
const tag=()=>randomBytes(8).toString('hex');
async function post(path,body) {
  const response=await fetch(base+path,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  return {status:response.status,data:await response.json()};
}
const request=number=>post('/v1/auth/driver-registration/otp',{phone:number});
const verify=(challengeId,otp)=>post('/v1/auth/driver-registration/otp/verify',{challengeId,otp});
const wrong=otp=>otp==='000000'?'999999':'000000';

async function enabled() {
  const number=phone();
  const challenge=await request(number);
  assert.equal(challenge.status,202);
  assert.match(challenge.data.challengeId,/^[0-9a-f-]{36}$/i);
  assert.match(challenge.data.otp??'',/^\d{6}$/);
  const resend=await request(number);
  assert.equal(resend.status,429,'resend within one minute is throttled');
  const invalid=await verify(challenge.data.challengeId,wrong(challenge.data.otp));
  assert.equal(invalid.status,400);
  assert.equal(invalid.data.errorCode,'OTP_INVALID_OR_EXPIRED');
  const proof=await verify(challenge.data.challengeId,challenge.data.otp);
  assert.equal(proof.status,200);
  assert.equal(proof.data.verifiedPhone,number);
  assert.ok(proof.data.verificationToken);
  const reuse=await verify(challenge.data.challengeId,challenge.data.otp);
  assert.equal(reuse.status,409);
  assert.equal(reuse.data.errorCode,'OTP_ALREADY_VERIFIED');
  const id=tag();
  const submit=await post('/v1/driver-applications',{
    verificationToken:proof.data.verificationToken,fullName:'CAB OTP Response Regression',
    email:`cab-otp-response-${id}@example.test`,password:randomBytes(24).toString('base64url')+'!',
    licenseNumber:`OTP-${id}`,vehicle:{plateNumber:`OTP-${id}`,vehicleType:'MOTORBIKE'}});
  assert.ok([201,202].includes(submit.status),`Driver submit ${submit.status}: ${submit.data.errorCode??''}`);
  const expired=await request(phone());
  assert.equal(expired.status,202);
  assert.match(expired.data.otp??'',/^\d{6}$/);
  const migrationPassword=readFileSync(join(dir,'identity_migration_password'),'utf8').trim();
  const db=new pg.Client({connectionString:
    `postgresql://identity_migration:${migrationPassword}@127.0.0.1:55439/cab_identity`,
    connectionTimeoutMillis:5000});
  await db.connect();
  try {
    const updated=await db.query("UPDATE driver_otp_challenge SET expires_at=now()-interval '1 second' WHERE challenge_id=$1",
      [expired.data.challengeId]);
    assert.equal(updated.rowCount,1);
  } finally {await db.end();}
  const late=await verify(expired.data.challengeId,expired.data.otp);
  assert.equal(late.status,400);
  assert.equal(late.data.errorCode,'OTP_INVALID_OR_EXPIRED');
  const limited=await request(phone());
  assert.equal(limited.status,202);
  assert.match(limited.data.otp??'',/^\d{6}$/);
  for(let attempt=0;attempt<5;attempt++) {
    const bad=await verify(limited.data.challengeId,wrong(limited.data.otp));
    assert.equal(bad.status,400);
    assert.equal(bad.data.errorCode,'OTP_INVALID_OR_EXPIRED');
  }
  const locked=await verify(limited.data.challengeId,limited.data.otp);
  assert.equal(locked.status,400);
  assert.equal(locked.data.errorCode,'OTP_INVALID_OR_EXPIRED');
  console.info('PASS OTP response 202 -> verify 200 -> Driver submit '+submit.status+
    '; wrong/expired/five-attempt 400, resend 429, one-use verify 409');
}

async function disabled() {
  const challenge=await request(phone());
  assert.equal(challenge.status,202);
  assert.ok(challenge.data.challengeId);
  assert.equal(Object.hasOwn(challenge.data,'otp'),false);
  console.info('PASS OTP request 202 without otp field in disabled/production mode');
}

if(process.argv[2]==='enabled')await enabled();
else if(process.argv[2]==='disabled')await disabled();
else throw Error('Use enabled or disabled');
