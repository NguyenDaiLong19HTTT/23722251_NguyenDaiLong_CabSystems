import {X509Certificate,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chownSync,chmodSync,copyFileSync,existsSync,mkdirSync,readFileSync,
  renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {validateWorkload} from './cert-policy.mjs';

const caPath='/run/secrets/cab_ca_cert',keyPath='/run/secrets/cab_ca_key',out='/out';
const ca=new X509Certificate(readFileSync(caPath));
if (!ca.ca||Date.now()<Date.parse(ca.validFrom)||
    Date.parse(ca.validTo)<Date.now()+31*86400000)
  throw new Error('CAB local CA cannot sign another broker certificate; renew CA deliberately');
const definitions=[
  ['gateway','api-gateway','clientAuth','URI:spiffe://cab.local/service/api-gateway'],
  ['identity','identity-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/identity-service'],
  ['customer','customer-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/customer-service'],
  ['driver','driver-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/driver-service'],
  ['notification','notification-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/notification-service'],
  ['payment','payment-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/payment-service'],
  ['trip','trip-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/trip-service'],
  ['booking','booking-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/booking-service'],
  ['rating','rating-service','serverAuth,clientAuth','URI:spiffe://cab.local/service/rating-service'],
  ['broker','rabbitmq','serverAuth','DNS:rabbitmq,DNS:localhost,IP:127.0.0.1'],
];
const utcStamp=date=>date.toISOString().replace(/[-:T]/g,'').replace(/\.\d{3}Z$/,'Z');
async function issue() {
const now=Date.now();
for (const [name,identity,eku,san] of definitions) {
  const days=name==='broker'?30:1;
  const dir=join(out,name);mkdirSync(dir,{recursive:true});
  const certPath=join(dir,`${name}.crt`),leafKey=join(dir,`${name}.key`);
  if (existsSync(certPath)!==existsSync(leafKey))
    throw new Error(`Partial ${name} certificate; refusing replacement`);
  let renew=true;
  if (existsSync(certPath)) {
    const cert=new X509Certificate(readFileSync(certPath));
    if (!cert.verify(ca.publicKey)||!cert.subjectAltName?.includes(san.split(',')[0]))
      throw new Error(`${name} certificate has unexpected issuer or identity`);
    if(name==='broker') renew=Date.parse(cert.validTo)<now+7*86400000;
    else {
      try {validateWorkload(readFileSync(certPath),{name,ca:readFileSync(caPath),
        key:readFileSync(leafKey),now,minimumRemainingMs:12*3600000});renew=false;}
      catch {renew=true;}
    }
  }
  if (renew) {
    const temp=join(dir,`issue-${randomBytes(8).toString('hex')}`);
    mkdirSync(temp);
    const run=args=>execFileSync('openssl',args,{cwd:temp,stdio:'ignore',timeout:30000});
    try {
      run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj',`/CN=unused-${identity}`,
        '-keyout',`${name}.key`,'-out',`${name}.csr`]);
      writeFileSync(join(temp,`${name}.ext`),
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n`+
        `extendedKeyUsage=${eku}\nsubjectAltName=${san}\n`);
      if(name==='broker') run(['x509','-req','-in',`${name}.csr`,'-CA',caPath,'-CAkey',keyPath,
        '-set_serial',`0x${randomBytes(16).toString('hex')}`,'-days',String(days),
        '-sha256','-extfile',`${name}.ext`,'-out',`${name}.crt`]);
      else {
        writeFileSync(join(temp,'index'),'');
        writeFileSync(join(temp,'serial'),`${randomBytes(16).toString('hex')}\n`);
        writeFileSync(join(temp,'ca.conf'),`[ca]\ndefault_ca=issuer\n[issuer]\n`+
          `database=${join(temp,'index')}\nserial=${join(temp,'serial')}\n`+
          `new_certs_dir=${temp}\ncertificate=${caPath}\nprivate_key=${keyPath}\n`+
          `default_md=sha256\npolicy=subject\n[subject]\ncommonName=supplied\n`);
        // A one-day OpenSSL x509 leaf can be 24h+1s; explicit UTC bounds leave
        // room for issuer latency and clock skew while remaining below 24h.
        const started=new Date(Date.now()-60000);
        const ends=new Date(Date.now()+23*3600000+50*60000);
        run(['ca','-batch','-config','ca.conf','-in',`${name}.csr`,
          '-startdate',utcStamp(started),'-enddate',utcStamp(ends),
          '-extfile',`${name}.ext`,'-notext','-out',`${name}.crt`]);
      }
      const cert=new X509Certificate(readFileSync(join(temp,`${name}.crt`)));
      if (!cert.verify(ca.publicKey)||!cert.subjectAltName?.includes(san.split(',')[0])||
          Date.parse(cert.validTo)<now+(days===1?23*3600000:29*86400000))
        throw new Error(`${name} issued certificate validation failed`);
      if(name!=='broker') validateWorkload(readFileSync(join(temp,`${name}.crt`)),{
        name,ca:readFileSync(caPath),key:readFileSync(join(temp,`${name}.key`)),
        now,minimumRemainingMs:23*3600000});
      if (name==='broker'&&existsSync(leafKey)) {
        // RabbitMQ mounts individual files: preserve their inodes across renewal.
        writeFileSync(leafKey,readFileSync(join(temp,`${name}.key`)));
        writeFileSync(certPath,readFileSync(join(temp,`${name}.crt`)));
      } else {
        renameSync(join(temp,`${name}.key`),leafKey);
        renameSync(join(temp,`${name}.crt`),certPath);
      }
    } finally {rmSync(temp,{recursive:true,force:true});}
  }
  if (name==='broker') {chownSync(leafKey,999,999);chmodSync(leafKey,0o640);}
  copyFileSync(caPath,join(dir,'ca.crt'));
}
console.info('CAB Compose dev certificates valid; private keys not printed.');
}
await issue();
while (!process.argv.includes('--once')) {
  await new Promise(resolve=>setTimeout(resolve,3600000));
  await issue();
}
