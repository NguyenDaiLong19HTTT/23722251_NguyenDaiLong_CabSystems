import {X509Certificate} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const pki=join(folder,'pki');
const active=join(pki,'active.json');
const selected=existsSync(active)?JSON.parse(readFileSync(active,'utf8')).directory:null;
if (selected!==null&&!/^issued-[0-9a-f-]{36}$/.test(selected))
  throw new Error('Invalid local certificate selection');
const leafDir=selected?join(pki,selected):pki;
const safeCode=error=>{
  const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
  return typeof code==='string'&&/^(28P01|3D000|42501|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)$/.test(code)
    ?code:'CONNECTION_FAILED';
};
let failed=false;
for (const service of ['identity','customer','driver']) {
  const role=`${service}_runtime`,db=`cab_${service}`;
  const passwordFile=join(folder,`${role}_password`);
  if (!existsSync(passwordFile)) {console.error(`${service}: runtime password file missing`);failed=true;continue;}
  const password=readFileSync(passwordFile,'utf8').trim();
  const url=new URL(`postgresql://${role}@127.0.0.1:55439/${db}`);
  url.password=password;
  const client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:3000});
  try {
    await client.connect();
    const result=await client.query('SELECT current_user AS role, current_database() AS db');
    if (result.rows[0]?.role!==role||result.rows[0]?.db!==db)
      throw new Error('Unexpected runtime database identity');
    console.info(`${service}: runtime database SELECT PASS`);
  } catch(error) {console.error(`${service}: runtime database ${safeCode(error)}`);failed=true;}
  finally {await client.end().catch(()=>undefined);}
}
const caPath=join(pki,'ca.crt');
if (!existsSync(caPath)) {console.error('CA certificate missing');failed=true;}
else {
  const ca=new X509Certificate(readFileSync(caPath));
  const now=Date.now();
  const caValid=ca.ca&&now>=Date.parse(ca.validFrom)&&now<Date.parse(ca.validTo);
  console.info(`CA: ${caValid?'valid':'invalid or expired'}`);
  if (!caValid) failed=true;
  for (const name of ['gateway','identity','customer','driver']) {
    const certPath=join(leafDir,`${name}.crt`),keyPath=join(leafDir,`${name}.key`);
    if (!existsSync(certPath)||!existsSync(keyPath)) {
      console.error(`${name}: workload certificate/key missing`);failed=true;continue;
    }
    const cert=new X509Certificate(readFileSync(certPath));
    const valid=now>=Date.parse(cert.validFrom)&&now<Date.parse(cert.validTo);
    const signed=cert.verify(ca.publicKey);
    const identity={gateway:'api-gateway',identity:'identity-service',
      customer:'customer-service',driver:'driver-service'}[name];
    const san=cert.subjectAltName===`URI:spiffe://cab.local/service/${identity}`;
    console.info(`${name}: ${valid?'valid':'expired/not-yet-valid'}, CA ${signed?'matched':'mismatch'}, URI SAN ${san?'matched':'mismatch'}`);
    if (!valid||!signed||!san) failed=true;
  }
}
if (failed) process.exitCode=1;
