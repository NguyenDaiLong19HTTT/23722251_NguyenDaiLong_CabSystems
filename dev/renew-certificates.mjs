import {X509Certificate,createPrivateKey,createPublicKey,randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const pki=join(root,'.secrets','customer-dev','pki');
const caCert=join(pki,'ca.crt'),caKey=join(pki,'ca.key');
if (!existsSync(caCert)||!existsSync(caKey)) throw new Error('Local CA missing; refusing to renew');
const ca=new X509Certificate(readFileSync(caCert));
const now=Date.now();
if (!ca.ca||now<Date.parse(ca.validFrom)||Date.parse(ca.validTo)<now+25*60*60*1000)
  throw new Error('Local CA cannot sign another 24-hour workload generation');
let openssl=process.env.CAB_DEV_OPENSSL;
if (!openssl) {
  try {execFileSync('openssl',['version'],{stdio:'ignore'});openssl='openssl';}
  catch {
    if (process.platform==='win32') {
      const git=execFileSync('where.exe',['git.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
      const candidate=join(dirname(dirname(git)),'usr','bin','openssl.exe');
      if (existsSync(candidate)) openssl=candidate;
    }
  }
}
if (!openssl) throw new Error('OpenSSL is required for local certificate renewal');
const directory=`issued-${randomUUID()}`;
const target=join(pki,directory);
mkdirSync(target);
const run=args=>execFileSync(openssl,args,{cwd:target,stdio:'ignore',timeout:15000});
for (const [name,identity,eku] of [
  ['gateway','api-gateway','clientAuth'],
  ['identity','identity-service','serverAuth,clientAuth'],
  ['customer','customer-service','serverAuth,clientAuth'],
  ['driver','driver-service','serverAuth,clientAuth'],
  ['notification','notification-service','serverAuth,clientAuth'],
]) {
  run(['req','-new','-newkey','rsa:2048','-nodes','-sha256',
    '-subj',`/CN=unused-${name}`,'-keyout',`${name}.key`,'-out',`${name}.csr`]);
  writeFileSync(join(target,`${name}.ext`),`basicConstraints=critical,CA:FALSE\n`+
    `keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${eku}\n`+
    `subjectAltName=URI:spiffe://cab.local/service/${identity}\n`);
  run(['x509','-req','-in',`${name}.csr`,'-CA',caCert,'-CAkey',caKey,
    '-set_serial',`0x${randomBytes(16).toString('hex')}`,'-days','1','-sha256',
    '-extfile',`${name}.ext`,'-out',`${name}.crt`]);
  const cert=new X509Certificate(readFileSync(join(target,`${name}.crt`)));
  const key=createPrivateKey(readFileSync(join(target,`${name}.key`)));
  const keyPublic=createPublicKey(key).export({type:'spki',format:'der'});
  const certPublic=cert.publicKey.export({type:'spki',format:'der'});
  const issuedAt=Date.now();
  if (issuedAt<Date.parse(cert.validFrom)||issuedAt>=Date.parse(cert.validTo)||
      Date.parse(cert.validTo)-Date.parse(cert.validFrom)>24*60*60*1000||
      !cert.verify(ca.publicKey)||!keyPublic.equals(certPublic)||
      cert.subjectAltName!==`URI:spiffe://cab.local/service/${identity}`)
    throw new Error(`New ${name} certificate validation failed; previous selection retained`);
}
const selection=join(pki,'active.json');
const temporary=join(pki,`active-${randomUUID()}.tmp`);
writeFileSync(temporary,JSON.stringify({directory})+'\n',{flag:'wx',mode:0o600});
renameSync(temporary,selection);
console.info('New 24-hour local workload certificates activated; CA and previous keys retained.');
