import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync,writeFileSync } from 'node:fs';
import { X509Certificate,randomBytes,randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const read=name=>readFileSync(join(folder,name),'utf8').trim();
if (!existsSync(join(folder,'project'))) throw new Error('Run npm.cmd run dev:setup first');
const project=read('project');
if (!/^cab-customer-dev-[0-9a-f-]{36}$/.test(project)) throw new Error('Invalid owned dev project');
const docker=process.env.CAB_DEV_DOCKER??'docker';
const pki=join(folder,'pki');
const activeFile=join(pki,'active.json');
const selection=existsSync(activeFile)?JSON.parse(readFileSync(activeFile,'utf8')).directory:null;
if (selection!==null&&!/^issued-[0-9a-f-]{36}$/.test(selection))
  throw new Error('Invalid local certificate selection');
const workloadPki=selection?join(pki,selection):pki;
const compose=['compose','--project-name',project,'--file',join(root,'dev','compose.yaml')];
const harnessProject=process.env.CAB_DEV_NOTIFICATION_HARNESS_PROJECT;
if (harnessProject&&!/^cab-notification-harness-[0-9a-f-]{36}$/.test(harnessProject))
  throw new Error('Invalid isolated Notification harness project');
const notificationProject=harnessProject??project;
const notificationCompose=harnessProject?
  ['compose','--project-name',harnessProject,'--file',
    join(root,'dev','notification-harness.compose.yaml')]:
  [...compose,'--file',join(root,'dev','notification.compose.yaml')];
const composeEnv={...process.env,CAB_DEV_SECRET_DIR:folder};
const command=(exe,args,env=composeEnv)=>{
  const result=spawnSync(exe,args,{cwd:root,env,stdio:'inherit',timeout:120000,windowsHide:true});
  if (result.error || result.status!==0) throw new Error('Development command failed');
};
const inspect=args=>execFileSync(docker,args,{encoding:'utf8',env:composeEnv,timeout:15000}).trim();
const url=(role,db)=>`postgresql://${role}:${read(role+'_password')}@127.0.0.1:55439/${db}`;
const port=(name,fallback)=>{
  const value=process.env[`CAB_DEV_${name}_PORT`]??fallback;
  if (!/^\d{4,5}$/.test(value)||Number(value)>65535) throw new Error('Invalid dev loopback port');
  return value;
};
const tls=(name,prefix,env)=>{
  env[prefix+'_CA_FILE']=join(folder,'pki','ca.crt');
  env[prefix+'_CERT_FILE']=join(workloadPki,name+'.crt');
  env[prefix+'_KEY_FILE']=join(workloadPki,name+'.key');
};
const checkCertificates=(includeNotification=false)=>{
  const ca=new X509Certificate(readFileSync(join(pki,'ca.crt')));
  const now=Date.now();
  if (!ca.ca||now<Date.parse(ca.validFrom)||now>=Date.parse(ca.validTo))
    throw new Error('Local CA is invalid or expired; refusing to start');
  for (const name of ['gateway','identity','customer','driver',
    ...(includeNotification?['notification']:[])]) {
    const certPath=join(workloadPki,name+'.crt'),keyPath=join(workloadPki,name+'.key');
    if (!existsSync(certPath)||!existsSync(keyPath))
      throw new Error(`Local ${name} workload certificate/key missing`);
    const cert=new X509Certificate(readFileSync(certPath));
    if (now<Date.parse(cert.validFrom))
      throw new Error(`Local ${name} workload certificate not yet valid; check clock with npm.cmd run dev:diagnose`);
    if (now>=Date.parse(cert.validTo))
      throw new Error(`Local ${name} workload certificate expired; run npm.cmd run dev:certs:renew`);
    if (!cert.verify(ca.publicKey)) throw new Error(`Local ${name} workload CA mismatch`);
  }
};
const runtime=(notification=false)=>{
  const env={...process.env,
    CAB_IDENTITY_RUNTIME_URL:url('identity_runtime','cab_identity'),
    CAB_CUSTOMER_RUNTIME_URL:url('customer_runtime','cab_customer'),
    CAB_DRIVER_RUNTIME_URL:url('driver_runtime','cab_driver'),
    IDENTITY_SERVICE_GRPC_BIND:`127.0.0.1:${port('IDENTITY_GRPC','50061')}`,
    CUSTOMER_SERVICE_GRPC_BIND:`127.0.0.1:${port('CUSTOMER_GRPC','50062')}`,
    DRIVER_SERVICE_GRPC_BIND:`127.0.0.1:${port('DRIVER_GRPC','50063')}`,
    IDENTITY_SERVICE_GRPC_TARGET:`127.0.0.1:${port('IDENTITY_GRPC','50061')}`,
    CUSTOMER_SERVICE_GRPC_TARGET:`127.0.0.1:${port('CUSTOMER_GRPC','50062')}`,
    DRIVER_SERVICE_GRPC_TARGET:`127.0.0.1:${port('DRIVER_GRPC','50063')}`,
    API_GATEWAY_HOST:'127.0.0.1',API_GATEWAY_PORT:port('GATEWAY','33001'),
    CAB_CUSTOMER_RECEIPT_KEY_FILE:join(folder,'customer_receipt_key'),
    CAB_DRIVER_LICENSE_KEY_FILE:join(folder,'driver_license_key'),
    CAB_DRIVER_APPLICATION_KEY_FILE:join(folder,'driver_application_key'),
    CAB_DEV_OTP_ENABLED:'1',
    CAB_DRIVER_DEMO_PASSWORD_FILE:join(folder,'driver_demo_password'),
    CAB_DRIVER_SEED_MANIFEST:join(folder,'driver_seed.json'),
    CAB_OPERATOR_DEMO_PASSWORD_FILE:join(folder,'operator_demo_password'),
    CAB_OPERATOR_SEED_MANIFEST:join(folder,'operator_seed.json'),
  };
  for (const purpose of ['contact','snapshot','lookup','idempotency','fingerprint','recovery',
    'refresh','receipt','jwt','otp','verification'])
    env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`]=join(folder,`identity_${purpose}_key`);
  tls('gateway','API_GATEWAY',env);tls('identity','IDENTITY_SERVICE',env);
  tls('customer','CUSTOMER_SERVICE',env);
  tls('driver','DRIVER_SERVICE',env);
  if (notification) {
    const amqps=(name,password)=>`amqps://${name}:${encodeURIComponent(password)}@127.0.0.1:${harnessProject?56792:56791}/%2Fcab`;
    const mongo=new URL(`mongodb://notification_runtime@127.0.0.1:${harnessProject?55441:55440}/cab_notification`);
    mongo.password=read('mongo_notification_password');
    env.CAB_NOTIFICATION_MONGO_URL=mongo.toString();
    env.CAB_DRIVER_AMQPS_URL=amqps('cab_driver_publisher',read('rabbit_driver_password'));
    env.CAB_NOTIFICATION_AMQPS_URL=amqps('cab_notification_consumer',read('rabbit_notification_password'));
    env.CAB_RABBIT_CA_FILE=join(pki,'ca.crt');
    env.CAB_NOTIFICATION_CURSOR_KEY_FILE=join(folder,'notification_cursor_key');
    env.CAB_NOTIFICATION_DLQ_KEY_FILE=join(folder,'notification_dlq_key');
    env.NOTIFICATION_SERVICE_GRPC_BIND=`127.0.0.1:${port('NOTIFICATION_GRPC','50064')}`;
    env.NOTIFICATION_SERVICE_GRPC_TARGET=env.NOTIFICATION_SERVICE_GRPC_BIND;
    tls('notification','NOTIFICATION_SERVICE',env);
  }
  return env;
};
const serviceRuntime=(base,service)=>{
  const env={...base};
  const owner=service.replace('-service','').replace('api-gateway','gateway');
  for (const name of ['IDENTITY','CUSTOMER','DRIVER'])
    {
      delete env[`CAB_${name}_MIGRATION_URL`];
      if (owner!==name.toLowerCase()) delete env[`CAB_${name}_RUNTIME_URL`];
    }
  for (const name of ['API_GATEWAY','IDENTITY_SERVICE','CUSTOMER_SERVICE',
    'DRIVER_SERVICE','NOTIFICATION_SERVICE'])
    if (name!==(owner==='gateway'?'API_GATEWAY':owner.toUpperCase()+'_SERVICE'))
      for (const suffix of ['CA_FILE','CERT_FILE','KEY_FILE']) delete env[`${name}_${suffix}`];
  if (owner!=='identity') for (const name of Object.keys(env))
    if (/^CAB_IDENTITY_.*_KEY_FILE$/.test(name)) delete env[name];
  if (owner!=='customer') delete env.CAB_CUSTOMER_RECEIPT_KEY_FILE;
  if (owner!=='driver') {
    delete env.CAB_DRIVER_LICENSE_KEY_FILE;
    delete env.CAB_DRIVER_APPLICATION_KEY_FILE;
    delete env.CAB_DRIVER_AMQPS_URL;
  }
  if (owner!=='notification') for (const name of ['CAB_NOTIFICATION_MONGO_URL',
    'CAB_NOTIFICATION_AMQPS_URL','CAB_NOTIFICATION_CURSOR_KEY_FILE',
    'CAB_NOTIFICATION_DLQ_KEY_FILE']) delete env[name];
  if (!['driver','notification'].includes(owner)) delete env.CAB_RABBIT_CA_FILE;
  for (const name of ['CAB_DRIVER_DEMO_PASSWORD_FILE','CAB_DRIVER_SEED_MANIFEST',
    'CAB_OPERATOR_DEMO_PASSWORD_FILE','CAB_OPERATOR_SEED_MANIFEST']) delete env[name];
  return env;
};
async function checkOwned() {
  const id=inspect([...compose,'ps','-q','postgres']);
  if (!id || inspect(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id])!==project)
    throw new Error('Refusing to operate on an unowned container');
}
async function initialize() {
  await checkOwned();
  const admin=new pg.Client({connectionString:url('postgres','postgres'),connectionTimeoutMillis:5000});
  await admin.connect();
  try {
    await admin.query('REVOKE ALL ON DATABASE postgres FROM PUBLIC');
    for (const service of ['identity','customer','driver']) {
      for (const suffix of ['migration','runtime']) {
        const role=service+'_'+suffix;
        const found=await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
        if (!found.rowCount) await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB
          NOCREATEROLE NOINHERIT PASSWORD '${read(role+'_password')}'`);
      }
      const db='cab_'+service;
      const found=await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[db]);
      if (!found.rowCount) await admin.query(`CREATE DATABASE ${db} OWNER ${service}_migration`);
      await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${service}_runtime`);
      const local=new pg.Client({connectionString:url('postgres',db)});
      await local.connect();
      try {
        await local.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await local.query(`GRANT USAGE ON SCHEMA public TO ${service}_runtime`);
      } finally {await local.end();}
    }
  } finally {await admin.end();}
}
const action=process.argv[2];
if (action==='up') {
  command(docker,[...compose,'up','-d','--wait','--wait-timeout','60']);
  await initialize();
  console.info('Owned PostgreSQL dev project ready; persistent volume retained.');
} else if (action==='migrate') {
  await checkOwned();
  const env=runtime();
  for (const service of ['identity','customer','driver']) {
    env[`CAB_${service.toUpperCase()}_MIGRATION_URL`]=url(service+'_migration','cab_'+service);
    command(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--config',
      `services/${service}-service/src/infrastructure/prisma/prisma.config.ts`],env);
    delete env[`CAB_${service.toUpperCase()}_MIGRATION_URL`];
  }
  console.info('Reviewed migrations deployed.');
} else if (action==='start' || action==='start-customer' || action==='start-driver'||
    action==='start-notification') {
  await checkOwned();
  const notification=action==='start-notification';
  if (notification) for (const name of ['rabbitmq','mongo']) {
    const id=inspect([...notificationCompose,'ps','-q',name]);
    if (!id||inspect(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id])!==notificationProject)
      throw new Error(`Owned ${name} resource is not running`);
  }
  checkCertificates(notification);
  const env=runtime(notification);
  const selected=action==='start-customer' ? [['customer-service','Customer']] :
    action==='start-driver' ? [['driver-service','Driver']] :
    process.argv[3]==='--without-customer' ? [['identity-service','Identity'],['api-gateway','Gateway']] :
      [['customer-service','Customer'],['identity-service','Identity'],
        ['driver-service','Driver'],
        ...(notification?[['notification-service','Notification']]:[]),
        ['api-gateway','Gateway']];
  const children=[];
  let stopping=false,unexpected=false;
  const stop=()=>{
    if (stopping) return;
    stopping=true;
    for (const {child} of children) if (child.exitCode===null) child.kill();
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const ready=[];const closed=[];
  for (const [service,label] of selected) {
    const child=spawn(process.execPath,[`services/${service}/dist/main.js`],{
      cwd:root,env:serviceRuntime(env,service),
      stdio:['inherit','inherit','inherit','ipc'],windowsHide:true});
    children.push({child,label});
    closed.push(new Promise(resolve=>child.once('close',resolve)));
    ready.push(new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`${label} readiness timed out`)),20000);
      const finish=fn=>value=>{clearTimeout(timer);fn(value);};
      child.on('message',message=>{
        if (message&&typeof message==='object'&&message.type==='cab-ready')
          finish(resolve)(undefined);
      });
      child.once('error',finish(()=>reject(new Error(`${label} could not be spawned`))));
      child.once('exit',finish(code=>reject(new Error(`${label} exited before ready (code ${code})`))));
    }));
    child.once('exit',code=>{
      if (!stopping) {
        unexpected=true;
        console.error(`${label} exited unexpectedly (code ${code}); stopping this dev group.`);
        stop();
      }
    });
  }
  try {await Promise.all(ready);}
  catch(error) {
    console.error(error instanceof Error?error.message:'CAB app readiness failed');
    stop();await Promise.all(closed);
    process.exitCode=1;
  }
  if (!stopping) {
    console.info('All selected CAB apps are ready on loopback; Ctrl+C stops this group, not PostgreSQL.');
    await Promise.all(closed);
    if (unexpected) process.exitCode=1;
  }
} else if (action==='seed-driver') {
  await checkOwned();
  const manifest=join(folder,'driver_seed.json');
  if (!existsSync(manifest)) {
    const suffix=randomBytes(6).toString('hex');
    const phone='09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0');
    const data={accountId:randomUUID(),driverId:randomUUID(),vehicleId:randomUUID(),
      assignmentId:randomUUID(),fullName:'Demo Driver',email:`driver-${suffix}@example.test`,
      phone,licenseNumber:`DEMO-${suffix.toUpperCase()}`,
      plateNumber:`DEMO-${suffix.toUpperCase()}`,vehicleType:'MOTORBIKE'};
    writeFileSync(manifest,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
  }
  const env=runtime();
  // Each executable owns only its service database. Rerun resumes after partial success.
  command(process.execPath,['services/driver-service/dist/seed.js'],env);
  command(process.execPath,['services/identity-service/dist/seed-driver.js'],env);
  console.info('Opt-in Driver seed ready; synthetic email/ID are in ignored local manifest.');
} else if (action==='seed-operator') {
  await checkOwned();
  const manifest=join(folder,'operator_seed.json');
  if (!existsSync(manifest)) {
    const suffix=randomBytes(6).toString('hex');
    writeFileSync(manifest,JSON.stringify({accountId:randomUUID(),operatorId:randomUUID(),
      fullName:'Demo Operator',email:`operator-${suffix}@example.test`,
      phone:'09'+String(randomBytes(4).readUInt32BE()%100_000_000).padStart(8,'0')},null,2),
      {flag:'wx',mode:0o600});
  }
  command(process.execPath,['services/identity-service/dist/seed-operator.js'],runtime());
  console.info('Opt-in Operator seed ready; synthetic email/ID are in ignored local manifest.');
} else if (action==='otp') {
  await checkOwned();
  const challenge=process.argv[3];
  if (!challenge||!/^[0-9a-f-]{36}$/i.test(challenge))
    throw new Error('Challenge ID is required');
  command(process.execPath,['services/identity-service/dist/otp-dev-read.js',challenge],runtime());
} else if (action==='stop') {
  await checkOwned();
  command(docker,[...compose,'stop']);
  console.info('Owned PostgreSQL dev container stopped; volume and secrets retained.');
} else if (action==='stop-notification') {
  await checkOwned();
  for (const name of ['rabbitmq','mongo']) {
    const id=inspect([...notificationCompose,'ps','-a','-q',name]);
    if (id&&inspect(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id])!==notificationProject)
      throw new Error(`Refusing unowned ${name} container`);
  }
  command(docker,[...notificationCompose,'stop','rabbitmq','mongo']);
  console.info('Owned Notification broker/MongoDB stopped; volumes and secrets retained.');
} else throw new Error('Usage: node dev/run.mjs up|migrate|seed-driver|seed-operator|otp <challengeId>|start|stop');
