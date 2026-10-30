import {PrismaPg} from '@prisma/adapter-pg';
import {readFileSync} from 'node:fs';
import {createIdentityClient} from '../services/identity-service/dist/infrastructure/prisma/client.js';
import {IdentityCrypto} from '../services/identity-service/dist/infrastructure/crypto.js';
import {canonicalPhone} from '@cab/phone-number';

// Read-only audit: never print contact values, IDs, ciphertext, URLs or keys.
if(!process.env.CAB_IDENTITY_RUNTIME_URL) {
  const url=new URL('postgresql://identity_runtime@postgres:5432/cab_identity');
  url.password=readFileSync('/cab-runtime/identity_runtime_password','utf8').trim();
  process.env.CAB_IDENTITY_RUNTIME_URL=url.toString();
  for(const name of ['contact','snapshot','lookup','idempotency','fingerprint',
    'recovery','refresh','receipt','jwt','otp','verification'])
    process.env[`CAB_IDENTITY_${name.toUpperCase()}_KEY_FILE`]=`/cab-runtime/identity_${name}_key`;
}
const url=process.env.CAB_IDENTITY_RUNTIME_URL;
if(!url)throw Error('Identity runtime configuration missing');
const db=createIdentityClient(new PrismaPg({connectionString:url,connectionTimeoutMillis:5000}));
const crypto=new IdentityCrypto();
let total=0,convertible=0,unsupported=0,overlengthLegacy=0,otherUnsupported=0;
let nonCanonicalDigest=0,duplicates=0;
const seen=new Set();
try {
  await db.$connect();
  const rows=await db.$queryRaw`SELECT account_id,phone_ciphertext,phone_nonce,phone_tag,
    phone_key_version,phone_lookup_hmac FROM account`;
  for(const row of rows) {
    total++;
    const value=crypto.open('contact',{ciphertext:row.phone_ciphertext,nonce:row.phone_nonce,
      tag:row.phone_tag,keyVersion:row.phone_key_version},`${row.account_id}:phone`);
    try {
      const canonical=canonicalPhone(value),digest=crypto.digest('lookup',`PHONE:${canonical}`);
      convertible++;
      if(!Buffer.from(row.phone_lookup_hmac).equals(Buffer.from(digest)))nonCanonicalDigest++;
      if(seen.has(canonical))duplicates++;
      seen.add(canonical);
    } catch {
      unsupported++;
      if(/^\+84[0-9]{10}$/.test(value))overlengthLegacy++;
      else otherUnsupported++;
    }
  }
  console.info(JSON.stringify({total,convertible,unsupported,overlengthLegacy,
    otherUnsupported,nonCanonicalDigest,duplicates}));
} finally {await db.$disconnect();}
