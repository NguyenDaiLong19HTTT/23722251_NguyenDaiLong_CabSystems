import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const pki=join(folder,'pki');
mkdirSync(folder,{recursive:true});
mkdirSync(pki,{recursive:true});
const writeOnce=(name,value)=>{
  const path=join(folder,name);
  if (!existsSync(path)) writeFileSync(path,value,{flag:'wx',mode:0o600});
};
writeOnce('project','cab-customer-dev-'+randomUUID());
for (const name of ['postgres_password','identity_migration_password','identity_runtime_password',
  'customer_migration_password','customer_runtime_password',
  'driver_migration_password','driver_runtime_password'])
  writeOnce(name,randomBytes(32).toString('base64url'));
for (const purpose of ['contact','snapshot','lookup','idempotency','fingerprint','recovery',
  'refresh','receipt','jwt','otp','verification']) writeOnce(`identity_${purpose}_key`,randomBytes(32).toString('base64url'));
writeOnce('customer_receipt_key',randomBytes(32).toString('base64url'));
writeOnce('driver_license_key',randomBytes(32).toString('base64url'));
writeOnce('driver_application_key',randomBytes(32).toString('base64url'));
writeOnce('operator_demo_password',randomBytes(24).toString('base64url')+'!');
writeOnce('driver_demo_password',randomBytes(24).toString('base64url')+'!');

let openssl=process.env.CAB_DEV_OPENSSL;
if (!openssl) {
  try { execFileSync('openssl',['version'],{stdio:'ignore'});openssl='openssl'; }
  catch {
    if (process.platform==='win32') {
      const git=execFileSync('where.exe',['git.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
      const candidate=join(dirname(dirname(git)),'usr','bin','openssl.exe');
      if (existsSync(candidate)) openssl=candidate;
    }
  }
}
if (!openssl) throw new Error('OpenSSL is required for local certificates');
const required=['ca.crt','ca.key','gateway.crt','gateway.key','identity.crt','identity.key',
  'customer.crt','customer.key'];
const present=required.filter(name=>existsSync(join(pki,name)));
if (present.length && present.length!==required.length)
  throw new Error('Partial local PKI exists; refusing to overwrite it');
if (!present.length) {
  const run=args=>execFileSync(openssl,args,{cwd:pki,stdio:'ignore',timeout:15000});
  run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','365',
    '-subj','/CN=CAB-LOCAL-DEV-CA','-keyout','ca.key','-out','ca.crt',
    '-addext','basicConstraints=critical,CA:TRUE',
    '-addext','keyUsage=critical,keyCertSign,cRLSign']);
  for (const [name,identity,eku] of [
    ['gateway','api-gateway','clientAuth'],
    ['identity','identity-service','serverAuth,clientAuth'],
    ['customer','customer-service','serverAuth,clientAuth'],
  ]) {
    run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj',`/CN=unused-${name}`,
      '-keyout',`${name}.key`,'-out',`${name}.csr`]);
    writeFileSync(join(pki,`${name}.ext`),`basicConstraints=critical,CA:FALSE\n`+
      `keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${eku}\n`+
      `subjectAltName=URI:spiffe://cab.local/service/${identity}\n`);
    run(['x509','-req','-in',`${name}.csr`,'-CA','ca.crt','-CAkey','ca.key',
      '-CAcreateserial','-days','1','-sha256','-extfile',`${name}.ext`,'-out',`${name}.crt`]);
  }
}
const driverFiles=['driver.crt','driver.key'];
const driverPresent=driverFiles.filter(name=>existsSync(join(pki,name)));
if (driverPresent.length===1) throw new Error('Partial Driver PKI exists; refusing to overwrite it');
if (!driverPresent.length) {
  const run=args=>execFileSync(openssl,args,{cwd:pki,stdio:'ignore',timeout:15000});
  run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj','/CN=unused-driver',
    '-keyout','driver.key','-out','driver.csr']);
  writeFileSync(join(pki,'driver.ext'),`basicConstraints=critical,CA:FALSE\n`+
    `keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\n`+
    `subjectAltName=URI:spiffe://cab.local/service/driver-service\n`);
  run(['x509','-req','-in','driver.csr','-CA','ca.crt','-CAkey','ca.key',
    '-CAcreateserial','-days','1','-sha256','-extfile','driver.ext','-out','driver.crt']);
}
console.info('Local development secrets and certificates are ready in the ignored .secrets directory.');
