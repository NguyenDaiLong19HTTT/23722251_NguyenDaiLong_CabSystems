import {PrismaPg} from '@prisma/adapter-pg';
import {createIdentityClient} from './infrastructure/prisma/client.js';
import {IdentityCrypto} from './infrastructure/crypto.js';

// Deliberately opt-in local terminal delivery. Never expose this through HTTP/gRPC.
if (process.env.CAB_DEV_OTP_ENABLED!=='1'||!process.env.CAB_IDENTITY_RUNTIME_URL)
  throw new Error('Development OTP reader is disabled');
const id=process.argv[2];
if (!id||!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Challenge ID is required');
const db=createIdentityClient(new PrismaPg({
  connectionString:process.env.CAB_IDENTITY_RUNTIME_URL,connectionTimeoutMillis:5000}));
try {
  await db.$connect();
  const rows=await db.$queryRaw<{delivery_ciphertext:Uint8Array;delivery_nonce:Uint8Array;
    delivery_tag:Uint8Array;delivery_key_version:string;expires_at:Date;
    invalidated_at:Date|null}[]>`SELECT delivery_ciphertext,delivery_nonce,delivery_tag,
      delivery_key_version,expires_at,invalidated_at FROM driver_otp_challenge
      WHERE challenge_id=${id}::uuid`;
  const row=rows[0];
  if (!row||row.invalidated_at||row.expires_at<=new Date())
    throw new Error('Challenge is unavailable');
  const code=new IdentityCrypto().open('otp',{ciphertext:row.delivery_ciphertext,
    nonce:row.delivery_nonce,tag:row.delivery_tag,keyVersion:row.delivery_key_version},id);
  // This explicit terminal output is solely for local dev demo, never app logs.
  process.stdout.write(code+'\n');
} finally {await db.$disconnect();}
