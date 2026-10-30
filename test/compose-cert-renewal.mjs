// Disposable Docker PKI test: never mounts CAB's real CA, keys or data volumes.
import {execFileSync} from 'node:child_process';
import {X509Certificate,createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';

const parent=resolve('.secrets');
const folder=mkdtempSync(join(parent,'cab-cert-test-'));
const image='cab/demo-node:24.19.0';
const watcher=`cab-cert-watch-test-${randomBytes(5).toString('hex')}`;
let watcherStarted=false;
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
const mount=`type=bind,source=${folder},target=/test`;
const issue=()=>docker(['run','--rm','--mount',mount,
  '--mount',`type=bind,source=${join(folder,'ca.crt')},target=/run/secrets/cab_ca_cert,readonly`,
  '--mount',`type=bind,source=${join(folder,'ca.key')},target=/run/secrets/cab_ca_key,readonly`,
  '--mount',`type=bind,source=${folder},target=/out`,
  image,'node','dev/compose/cert-init.mjs','--once']);
const healthOk=()=>{
  try {docker(['run','--rm','--mount',mount,
    '--mount',`type=bind,source=${join(folder,'ca.crt')},target=/run/secrets/cab_ca_cert,readonly`,
    '--mount',`type=bind,source=${folder},target=/out`,
    image,'node','dev/compose/health.mjs','certs']);return true;}
  catch {return false;}
};
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const stamp=date=>date.toISOString().replace(/[-:T]/g,'').replace(/\.\d{3}Z$/,'Z');
const until=async(check,seconds)=>{
  for(let n=0;n<seconds;n+=2){if(check())return;await new Promise(resolve=>setTimeout(resolve,2000));}
  throw new Error('Certificate watcher did not restart within bounded test interval');
};
try {
  docker(['run','--rm','--mount',mount,image,'openssl','req','-x509','-newkey','rsa:2048',
    '-nodes','-sha256','-days','90','-subj','/CN=CAB-ISOLATED-TEST-CA',
    '-keyout','/test/ca.key','-out','/test/ca.crt',
    '-addext','basicConstraints=critical,CA:TRUE',
    '-addext','keyUsage=critical,keyCertSign,cRLSign']);
  issue();
  const names=['gateway','identity','customer','driver','notification','payment','trip','booking','rating'];
  for(const name of names) {
    const cert=new X509Certificate(readFileSync(join(folder,name,`${name}.crt`)));
    const span=Date.parse(cert.validTo)-Date.parse(cert.validFrom);
    if(span<=0||span>86400000||Date.parse(cert.validTo)-Date.now()<23*3600000)
      throw new Error(`${name} issued outside workload lifetime policy`);
  }
  const gateway=join(folder,'gateway','gateway.crt');
  const first=hash(gateway);
  issue();
  if(hash(gateway)!==first) throw new Error('Valid certificate rotated unnecessarily');
  if(!healthOk()) throw new Error('Healthy certificate set failed healthcheck');

  // Sign deliberately invalid leaves with the same disposable key and CA.
  writeFileSync(join(folder,'index'),'');
  writeFileSync(join(folder,'serial'),'2000\n');
  writeFileSync(join(folder,'ca.conf'),`[ca]\ndefault_ca=issuer\n[issuer]\n`+
    `database=/test/index\nserial=/test/serial\nnew_certs_dir=/test\n`+
    `certificate=/test/ca.crt\nprivate_key=/test/ca.key\n`+
    `default_md=sha256\npolicy=subject\n[subject]\ncommonName=supplied\n`);
  writeFileSync(join(folder,'gateway.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'+
    'extendedKeyUsage=clientAuth\nsubjectAltName=URI:spiffe://cab.local/service/api-gateway\n');
  docker(['run','--rm','--mount',mount,image,'openssl','req','-new','-sha256',
    '-subj','/CN=unused-api-gateway','-key','/test/gateway/gateway.key',
    '-out','/test/gateway.csr']);
  const sign=(from,to)=>{
    writeFileSync(join(folder,'index'),'');
    docker(['run','--rm','--mount',mount,image,'openssl','ca','-batch','-config','/test/ca.conf',
      '-in','/test/gateway.csr','-startdate',stamp(new Date(from)),
      '-enddate',stamp(new Date(to)),'-extfile','/test/gateway.ext',
      '-notext','-out','/test/gateway/gateway.crt']);
  };
  const now=Date.now();
  const start=Math.floor((now-60000)/1000)*1000;
  sign(start,start+86401000);
  if(healthOk()) throw new Error('24h+1s certificate passed healthcheck');
  const overlong=hash(gateway);
  issue();
  if(hash(gateway)===overlong||!healthOk())
    throw new Error('Overlong certificate was not safely renewed');

  // No published port, Docker network, CAB data mount or real secret. The real
  // Compose launcher must restart its Gateway child when this test leaf rotates.
  docker(['run','--rm','-d','--name',watcher,'--network','none','--read-only',
    '--tmpfs','/tmp','--mount',`type=bind,source=${join(folder,'gateway')},target=/cab-pki,readonly`,
    image,'node','dev/compose/launch.mjs','gateway']);
  watcherStarted=true;
  const starts=()=>docker(['logs',watcher]).split('api-gateway: HTTP listener initialized.').length-1;
  await until(()=>starts()>=1,20);

  sign(Date.now()-23*3600000,Date.now()+30*60000);
  const nearExpiry=hash(gateway);
  if(healthOk()) throw new Error('Near-expiry certificate passed healthcheck');
  issue();
  if(hash(gateway)===nearExpiry) throw new Error('Near-expiry certificate was not renewed');
  const renewed=new X509Certificate(readFileSync(gateway));
  if(Date.parse(renewed.validTo)-Date.now()<23*3600000)
    throw new Error('Renewed certificate has insufficient lifetime');
  await until(()=>starts()>=2,80);
  console.log('Isolated CA: nine bounded leaves; valid leaf kept; 24h+1s and near-expiry leaves denied/renewed; launcher child restarted. PASS');
} finally {
  try {if(watcherStarted) docker(['rm','-f',watcher]);}
  finally {
    const path=realpathSync(folder);
    if(dirname(path)!==realpathSync(parent)||!basename(path).startsWith('cab-cert-test-'))
      throw new Error('Refusing certificate test cleanup outside owned directory');
    rmSync(path,{recursive:true,force:true});
  }
}
