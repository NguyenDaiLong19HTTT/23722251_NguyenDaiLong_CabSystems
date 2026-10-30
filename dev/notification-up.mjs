import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import amqp from 'amqplib';
import {MongoClient} from 'mongodb';

const root=fileURLToPath(new URL('../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const read=name=>readFileSync(join(folder,name),'utf8').trim();
const project=read('project');
if (!/^cab-customer-dev-[0-9a-f-]{36}$/.test(project)) throw new Error('Invalid owned dev project');
const harness=process.env.CAB_DEV_NOTIFICATION_HARNESS_PROJECT;
if (harness&&!/^cab-notification-harness-[0-9a-f-]{36}$/.test(harness))
  throw new Error('Invalid isolated Notification harness project');
const selectedProject=harness??project;
const brokerPort=harness?56792:56791,mongoPort=harness?55441:55440;
const docker=process.env.CAB_DEV_DOCKER??'docker';
const compose=['compose','--project-name',selectedProject,
  ...(harness?[]:['--file',join(root,'dev','compose.yaml')]),
  '--file',join(root,'dev',harness?'notification-harness.compose.yaml':'notification.compose.yaml')];
const env={...process.env,CAB_DEV_SECRET_DIR:folder};
const command=(args,quiet=false)=>execFileSync(docker,args,{cwd:root,env,
  encoding:quiet?undefined:'utf8',stdio:quiet?'ignore':'pipe',timeout:120000,windowsHide:true});
const inspect=args=>command(args).toString().trim();
const owned=id=>id&&inspect(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id])===selectedProject;
if (!harness) {
  const postgres=inspect([...compose,'ps','-q','postgres']);
  if (!owned(postgres)) throw new Error('Owned PostgreSQL dev project is not running');
}
for (const name of ['rabbitmq','mongo']) {
  const id=inspect([...compose,'ps','-a','-q',name]);
  if (id&&!owned(id)) throw new Error(`Refusing unowned ${name} container`);
}
command([...compose,'up','-d','--wait','--wait-timeout','120','rabbitmq','mongo'],true);
const rabbit=inspect([...compose,'ps','-q','rabbitmq']);
const mongo=inspect([...compose,'ps','-q','mongo']);
if (!owned(rabbit)||!owned(mongo)) throw new Error('Notification containers not owned by this project');
const ctl=(args,quiet=false)=>command(['exec',rabbit,'rabbitmqctl',...args],quiet);
const vhosts=ctl(['list_vhosts','--silent']).toString().split(/\r?\n/);
if (!vhosts.includes('/cab')) ctl(['add_vhost','/cab'],true);
const users=ctl(['list_users','--silent']).toString();
for (const [name,passwordFile] of [
  ['cab_dev_admin','rabbit_admin_password'],
  ['cab_driver_publisher','rabbit_driver_password'],
  ['cab_notification_consumer','rabbit_notification_password'],
]) {
  if (!new RegExp(`^${name}\\s`,'m').test(users))
    ctl(['add_user',name,read(passwordFile)],true);
}
ctl(['set_user_tags','cab_dev_admin','administrator'],true);
ctl(['set_permissions','-p','/cab','cab_dev_admin','.*','.*','.*'],true);
ctl(['set_permissions','-p','/cab','cab_driver_publisher','^$','^cab\\.driver\\.events$','^$'],true);
ctl(['set_permissions','-p','/cab','cab_notification_consumer','^$',
  '^cab\\.notification\\.dead$','^cab\\.notification\\.v2$'],true);
ctl(['set_topic_permissions','-p','/cab','cab_driver_publisher','cab.driver.events',
  '^notification\\.v2\\.DRIVER_APPLICATION_(SUBMITTED|APPROVED|REJECTED)$','^$'],true);
if (/^guest\s/m.test(users)) ctl(['delete_user','guest'],true);
const uri=(name,password)=>`amqps://${name}:${encodeURIComponent(password)}@127.0.0.1:${brokerPort}/%2Fcab`;
const ca=readFileSync(join(folder,'pki','ca.crt'));
let connection;
try {
  connection=await amqp.connect(uri('cab_dev_admin',read('rabbit_admin_password')),
    {ca,servername:'localhost',rejectUnauthorized:true,timeout:5000});
  const channel=await connection.createChannel();
  await channel.assertExchange('cab.driver.events','topic',{durable:true});
  await channel.assertExchange('cab.notification.dead','direct',{durable:true});
  await channel.assertQueue('cab.notification.v2',{durable:true,arguments:{'x-queue-type':'quorum'}});
  await channel.assertQueue('cab.notification.v2.dlq',{durable:true,arguments:{'x-queue-type':'quorum'}});
  await channel.bindQueue('cab.notification.v2','cab.driver.events','notification.v2.*');
  await channel.bindQueue('cab.notification.v2.dlq','cab.notification.dead','cab.notification.v2');
  await channel.close();
} catch {throw new Error('AMQPS topology bootstrap failed; credentials and TLS withheld');}
finally {await connection?.close().catch(()=>undefined);}
const mongoUrl=new URL(`mongodb://notification_runtime@127.0.0.1:${mongoPort}/cab_notification`);
mongoUrl.password=read('mongo_notification_password');
const client=new MongoClient(mongoUrl.toString(),{serverSelectionTimeoutMS:5000,maxPoolSize:2});
try {await client.connect();await client.db('cab_notification').command({ping:1});}
catch {throw new Error('MongoDB notification runtime authentication failed');}
finally {await client.close().catch(()=>undefined);}
console.info(`Owned ${harness?'harness':'dev'} AMQPS/MongoDB notification resources healthy; topology and scoped users ready.`);
