import {readFileSync} from 'node:fs';
import {PrismaPg} from '@prisma/adapter-pg';
import {createIdentityClient} from './infrastructure/prisma/client.js';
import {IdentityCrypto} from './infrastructure/crypto.js';
import {canonicalPhone} from '@cab/phone-number';

const path=process.env.CAB_OPERATOR_SEED_MANIFEST;
const passwordFile=process.env.CAB_OPERATOR_DEMO_PASSWORD_FILE;
const url=process.env.CAB_IDENTITY_RUNTIME_URL;
if (!path||!passwordFile||!url) throw new Error('Operator seed configuration is missing');
const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,string>;
const password=readFileSync(passwordFile,'utf8').trim();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!uuid.test(data.accountId??'')||!uuid.test(data.operatorId??'')||
    !/^(?:0[0-9]{9}|\+[1-9][0-9]{7,14})$/.test(data.phone??'')||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email??'')||password.length<8)
  throw new Error('Operator seed configuration is invalid');
const crypto=new IdentityCrypto(),db=createIdentityClient(new PrismaPg({
  connectionString:url,connectionTimeoutMillis:5000}));
try {
  await db.$connect();
  const rows=await db.$queryRaw<{role:string;confirmed_profile_id:string;
    registration_access_state:string}[]>`SELECT role,confirmed_profile_id,
    registration_access_state FROM account WHERE account_id=${data.accountId}::uuid`;
  if (rows[0]) {
    if (rows[0].role!=='OPERATOR'||rows[0].confirmed_profile_id!==data.operatorId||
        rows[0].registration_access_state!=='READY') throw new Error('Operator seed binding conflict');
  } else {
    const email=data.email!.toLowerCase(),phone=canonicalPhone(data.phone!);
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
      ${encryptedPhone.keyVersion},${crypto.digest('lookup',`EMAIL:${email}`)},
      ${crypto.digest('lookup',`PHONE:${phone}`)},${crypto.version},${hash},
      'OPERATOR','ACTIVE','READY',${data.operatorId}::uuid,now())`;
  }
  console.info('Identity-owned Operator seed ready (new or verified existing).');
} finally {await db.$disconnect();}
