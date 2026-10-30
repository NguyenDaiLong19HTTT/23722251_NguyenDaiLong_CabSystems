import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { createIdentityClient } from './infrastructure/prisma/client.js';
import { IdentityCrypto } from './infrastructure/crypto.js';
import {canonicalPhone} from '@cab/phone-number';

// Opt-in dev seed, owned solely by Identity. Driver side is verified first by
// dev orchestration; no cross-DB transaction or direct Driver DB access here.
const path=process.env.CAB_DRIVER_SEED_MANIFEST,url=process.env.CAB_IDENTITY_RUNTIME_URL;
const passwordFile=process.env.CAB_DRIVER_DEMO_PASSWORD_FILE;
if (!path||!url||!passwordFile) throw new Error('Identity Driver seed configuration is missing');
const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,string>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!uuid.test(data.accountId??'')||!uuid.test(data.driverId??'')||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email??'')||
    !/^(?:0[0-9]{9}|\+[1-9][0-9]{7,14})$/.test(data.phone??'')||!data.fullName)
  throw new Error('Identity Driver seed manifest is invalid');
const crypto=new IdentityCrypto();
const password=readFileSync(passwordFile,'utf8').trim();
if (password.length<8) throw new Error('Driver demo password file is invalid');
const email=data.email!.trim().toLowerCase(),phone=canonicalPhone(data.phone!);
const emailDigest=crypto.digest('lookup',`EMAIL:${email}`),phoneDigest=crypto.digest('lookup',`PHONE:${phone}`);
const db=createIdentityClient(new PrismaPg({connectionString:url,connectionTimeoutMillis:5000}));
try {
  await db.$connect();
  const existing=await db.$queryRaw<{role:string;confirmed_profile_id:string;
    registration_access_state:string}[]>`
      SELECT role,confirmed_profile_id,registration_access_state FROM account
      WHERE account_id=${data.accountId}::uuid`;
  if (existing[0]) {
    if (existing[0].role!=='DRIVER'||existing[0].confirmed_profile_id!==data.driverId||
        existing[0].registration_access_state!=='READY') throw new Error('Identity seed binding conflict');
  } else {
    const conflict=await db.$queryRaw<{account_id:string}[]>`
      SELECT account_id FROM account WHERE email_lookup_hmac=${emailDigest}
        OR phone_lookup_hmac=${phoneDigest} LIMIT 1`;
    if (conflict[0]) throw new Error('Identity seed contact conflict');
    const encryptedEmail=crypto.seal('contact',email,`${data.accountId}:email`);
    const encryptedPhone=crypto.seal('contact',phone,`${data.accountId}:phone`);
    const hash=await crypto.hashPassword(password);
    await db.$executeRaw`INSERT INTO account(account_id,full_name,email_ciphertext,email_nonce,
      email_tag,email_key_version,phone_ciphertext,phone_nonce,phone_tag,phone_key_version,
      email_lookup_hmac,phone_lookup_hmac,lookup_key_version,password_hash,role,account_status,
      registration_access_state,confirmed_profile_id,profile_confirmed_at)
      VALUES (${data.accountId}::uuid,${data.fullName},${encryptedEmail.ciphertext},
      ${encryptedEmail.nonce},${encryptedEmail.tag},${encryptedEmail.keyVersion},
      ${encryptedPhone.ciphertext},${encryptedPhone.nonce},${encryptedPhone.tag},
      ${encryptedPhone.keyVersion},${emailDigest},${phoneDigest},${crypto.version},
      ${hash},'DRIVER','ACTIVE','READY',${data.driverId}::uuid,now())`;
  }
  console.info('Identity-owned Driver account seed ready (new or verified existing).');
} finally {await db.$disconnect();}
