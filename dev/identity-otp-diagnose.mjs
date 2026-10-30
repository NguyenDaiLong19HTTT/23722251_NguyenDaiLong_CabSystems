import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PrismaPg} from '@prisma/adapter-pg';
import {createIdentityClient} from '../services/identity-service/dist/infrastructure/prisma/client.js';
import {IdentityCrypto} from '../services/identity-service/dist/infrastructure/crypto.js';
import {IdentityDriverRegistration} from '../services/identity-service/dist/application/driver-registration.js';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'.secrets','customer-dev');
const read=name=>readFileSync(join(dir,name),'utf8').trim();
process.env.CAB_IDENTITY_RUNTIME_URL=`postgresql://identity_runtime:${read('identity_runtime_password')}@127.0.0.1:55439/cab_identity`;
process.env.CAB_DEV_OTP_ENABLED='1';
process.env.IDENTITY_SERVICE_GRPC_TARGET='127.0.0.1:50261';
process.env.DRIVER_SERVICE_GRPC_TARGET='127.0.0.1:50263';
for (const purpose of ['contact','snapshot','lookup','idempotency','fingerprint','recovery',
  'refresh','receipt','jwt','otp','verification'])
  process.env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`]=join(dir,`identity_${purpose}_key`);
for (const [name,service] of [['identity','IDENTITY_SERVICE']]) {
  for (const [suffix,file] of [['CA_FILE','ca.crt'],['CERT_FILE',`${name}.crt`],['KEY_FILE',`${name}.key`]])
    process.env[`${service}_${suffix}`]=join(dir,'pki',file);
}
const db=createIdentityClient(new PrismaPg({connectionString:process.env.CAB_IDENTITY_RUNTIME_URL,
  connectionTimeoutMillis:5000}));
await db.$connect();
const commands=new IdentityDriverRegistration(db,new IdentityCrypto());
try {
  await commands.requestOtp({phone:'09'+String(Math.floor(Math.random()*1e8)).padStart(8,'0')});
  console.info('Identity OTP command accepted');
} catch(error) {
  console.info('Identity OTP database/error codes',error.code,error.meta?.code,
    error.cause?.code,Object.keys(error.meta??{}),
    Object.keys(error.meta?.driverAdapterError??{}),
    error.meta?.driverAdapterError?.cause?.code,
    Object.keys(error.meta?.driverAdapterError?.cause??{}),
    error.meta?.driverAdapterError?.cause?.kind,
    error.meta?.driverAdapterError?.cause?.type);
} finally {commands.close();await db.$disconnect();}
