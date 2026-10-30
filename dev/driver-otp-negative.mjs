import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {IdentityCrypto} from '../services/identity-service/dist/infrastructure/crypto.js';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'.secrets','customer-dev');
const read=name=>readFileSync(join(dir,name),'utf8').trim();
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33001';
const phone=()=>'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
async function call(path,body,key) {
  const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',
    ...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
const db=new pg.Client({connectionString:`postgresql://identity_migration:${read('identity_migration_password')}@127.0.0.1:55439/cab_identity`,
  connectionTimeoutMillis:5000});
await db.connect();
try {
  const number=phone();
  const challenge=await call('/v1/auth/driver-registration/otp',{phone:number});
  assert.equal(challenge.status,202);
  const repeat=await call('/v1/auth/driver-registration/otp',{phone:number});
  assert.equal(repeat.status,429,'same phone resend throttle');
  await db.query(`UPDATE driver_otp_challenge SET expires_at=now()-interval '1 second'
    WHERE challenge_id=$1`,[challenge.body.challengeId]);
  const expired=await call('/v1/auth/driver-registration/otp/verify',
    {challengeId:challenge.body.challengeId,otp:'000000'});
  assert.equal(expired.status,400);
  assert.equal(expired.body.errorCode,'OTP_INVALID_OR_EXPIRED');

  const attempts=await call('/v1/auth/driver-registration/otp',{phone:phone()});
  assert.equal(attempts.status,202);
  for (let i=0;i<5;i++) {
    const bad=await call('/v1/auth/driver-registration/otp/verify',
      {challengeId:attempts.body.challengeId,otp:'000000'});
    assert.equal(bad.status,400);
  }
  const count=await db.query('SELECT failed_attempts,invalidated_at FROM driver_otp_challenge WHERE challenge_id=$1',
    [attempts.body.challengeId]);
  assert.equal(count.rows[0].failed_attempts,5);
  assert.ok(count.rows[0].invalidated_at,'fifth failure invalidated challenge');
  const blocked=await call('/v1/auth/driver-registration/otp/verify',
    {challengeId:attempts.body.challengeId,otp:'000000'});
  assert.equal(blocked.status,400);
  const proofChallenge=await call('/v1/auth/driver-registration/otp',{phone:phone()});
  assert.equal(proofChallenge.status,202);
  for (const purpose of ['contact','snapshot','lookup','idempotency','fingerprint','recovery',
    'refresh','receipt','jwt','otp','verification'])
    process.env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`]=join(dir,`identity_${purpose}_key`);
  const codeRow=await db.query(`SELECT delivery_ciphertext,delivery_nonce,delivery_tag,delivery_key_version
    FROM driver_otp_challenge WHERE challenge_id=$1`,[proofChallenge.body.challengeId]);
  const sealed=codeRow.rows[0];
  const code=new IdentityCrypto().open('otp',{ciphertext:sealed.delivery_ciphertext,
    nonce:sealed.delivery_nonce,tag:sealed.delivery_tag,keyVersion:sealed.delivery_key_version},
    proofChallenge.body.challengeId);
  const verified=await call('/v1/auth/driver-registration/otp/verify',
    {challengeId:proofChallenge.body.challengeId,otp:code});
  assert.equal(verified.status,200);
  await db.query(`UPDATE driver_phone_verification SET expires_at=now()-interval '1 second'
    WHERE challenge_id=$1`,[proofChallenge.body.challengeId]);
  const expiredProof=await call('/v1/driver-applications',{
    verificationToken:verified.body.verificationToken,fullName:'Expired Proof',
    email:`expired-${randomUUID()}@example.test`,password:'safe-password-for-test',
    licenseNumber:`EX-${randomUUID()}`,vehicle:{plateNumber:'EXPIRED',vehicleType:'MOTORBIKE'}},randomUUID());
  assert.equal(expiredProof.status,400);
  assert.equal(expiredProof.body.errorCode,'VERIFICATION_TOKEN_INVALID_OR_EXPIRED');
  const forged=await call('/v1/driver-applications',{
    verificationToken:'x'.repeat(43),fullName:'Forged',email:`forged-${randomUUID()}@example.test`,
    password:'safe-password-for-test',licenseNumber:'FORGED',
    vehicle:{plateNumber:'FORGED',vehicleType:'MOTORBIKE'},phoneVerified:true},randomUUID());
  assert.equal(forged.status,400,'client phoneVerified flag cannot establish proof');
  console.info('PASS Driver OTP negatives: resend 429, expired challenge/proof 400, five attempts invalidate, forged flag 400');
} finally {await db.end();}
