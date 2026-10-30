import {execFileSync} from 'node:child_process';
import {X509Certificate,randomBytes,randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const pki=join(folder,'pki');
const broker=join(folder,'broker-pki');
if (!existsSync(join(folder,'project'))||!existsSync(join(pki,'ca.crt'))||
    !existsSync(join(pki,'ca.key'))) throw new Error('Run dev:setup before notification setup');
const ca=new X509Certificate(readFileSync(join(pki,'ca.crt')));
if (!ca.ca||Date.parse(ca.validTo)<Date.now()+31*86400000)
  throw new Error('Local CA cannot issue a 30-day broker certificate');
mkdirSync(broker,{recursive:true});
const writeOnce=(name,value)=>{
  const path=join(folder,name);
  if (!existsSync(path)) writeFileSync(path,value,{flag:'wx',mode:0o600});
};
writeOnce('notification_harness_project','cab-notification-harness-'+randomUUID());
for (const name of ['mongo_root_password','mongo_notification_password',
  'rabbit_admin_password','rabbit_driver_password','rabbit_notification_password',
  'notification_cursor_key','notification_dlq_key'])
  writeOnce(name,randomBytes(32).toString('base64url'));
const init=join(folder,'mongo-init.js');
if (!existsSync(init)) {
  const password=readFileSync(join(folder,'mongo_notification_password'),'utf8').trim();
  writeFileSync(init,`db = db.getSiblingDB('cab_notification');\n`+
    `db.createUser({user:'notification_runtime',pwd:${JSON.stringify(password)},`+
    `roles:[{role:'readWrite',db:'cab_notification'}]});\n`,{flag:'wx',mode:0o600});
}
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
if (!openssl) throw new Error('OpenSSL is required for local broker TLS');
const cert=join(broker,'broker.crt'),key=join(broker,'broker.key');
if (existsSync(cert)!==existsSync(key)) throw new Error('Partial broker PKI; refusing overwrite');
if (!existsSync(cert)) {
  const run=args=>execFileSync(openssl,args,{cwd:broker,stdio:'ignore',timeout:15000});
  run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj','/CN=localhost',
    '-keyout','broker.key','-out','broker.csr']);
  writeFileSync(join(broker,'broker.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'+
    'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run(['x509','-req','-in','broker.csr','-CA',join(pki,'ca.crt'),'-CAkey',join(pki,'ca.key'),
    '-set_serial',`0x${randomBytes(16).toString('hex')}`,'-days','30','-sha256',
    '-extfile','broker.ext','-out','broker.crt']);
}
const leaf=new X509Certificate(readFileSync(cert));
if (Date.now()<Date.parse(leaf.validFrom)||Date.now()>=Date.parse(leaf.validTo)||
    !leaf.verify(ca.publicKey)||!leaf.subjectAltName?.includes('IP Address:127.0.0.1'))
  throw new Error('Broker certificate invalid or expired; previous files retained');
const selectedFile=join(pki,'active.json');
const selected=existsSync(selectedFile)?JSON.parse(readFileSync(selectedFile,'utf8')).directory:null;
if (selected!==null&&!/^issued-[0-9a-f-]{36}$/.test(selected))
  throw new Error('Invalid local workload certificate selection');
const workload=selected?join(pki,selected):pki;
const notificationCert=join(workload,'notification.crt');
const notificationKey=join(workload,'notification.key');
if (existsSync(notificationCert)!==existsSync(notificationKey))
  throw new Error('Partial Notification PKI; refusing overwrite');
if (!existsSync(notificationCert)) {
  const run=args=>execFileSync(openssl,args,{cwd:workload,stdio:'ignore',timeout:15000});
  run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj','/CN=unused-notification',
    '-keyout','notification.key','-out','notification.csr']);
  writeFileSync(join(workload,'notification.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'+
    'extendedKeyUsage=serverAuth,clientAuth\n'+
    'subjectAltName=URI:spiffe://cab.local/service/notification-service\n');
  run(['x509','-req','-in','notification.csr','-CA',join(pki,'ca.crt'),
    '-CAkey',join(pki,'ca.key'),'-set_serial',`0x${randomBytes(16).toString('hex')}`,
    '-days','1','-sha256','-extfile','notification.ext','-out','notification.crt']);
}
console.info('Notification dev credentials and broker TLS material ready in ignored local files.');
