// Add only Payment publisher permissions and topology inside the existing demo broker.
import {readFileSync} from 'node:fs';
import amqp from 'amqplib';

const read=name=>readFileSync(`/cab-runtime/${name}`,'utf8').trim();
const admin=read('rabbit_admin_password');
const payment=read('rabbit_payment_password');
const auth='Basic '+Buffer.from(`cab_dev_admin:${admin}`).toString('base64');
const request=async(path,method,body)=>{
  const response=await fetch(`http://rabbitmq:15672/api/${path}`,{
    method,headers:{Authorization:auth,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error(`Payment broker setup failed (${response.status})`);
  return response;
};
try {
  const existing=await fetch('http://rabbitmq:15672/api/users/cab_payment_publisher',{
    headers:{Authorization:auth},signal:AbortSignal.timeout(5000)});
  if (existing.status===404) await request('users/cab_payment_publisher','PUT',
    {password:payment,tags:''});
  else if (!existing.ok) throw new Error(`Payment broker user check failed (${existing.status})`);
  await request('permissions/%2Fcab/cab_payment_publisher','PUT',{
    configure:'^$',write:'^cab\\.payment\\.events$',read:'^$'});
  await request('topic-permissions/%2Fcab/cab_payment_publisher','PUT',{
    exchange:'cab.payment.events',write:'^notification\\.v2\\.PAYMENT_(SUCCESS|FAILED|REVIEW_REQUIRED)$',read:'^$'});
  const url=new URL('amqps://cab_dev_admin@rabbitmq:5671/%2Fcab');
  url.password=admin;
  const connection=await amqp.connect(url.toString(),{
    ca:readFileSync('/cab-pki/ca.crt'),servername:'rabbitmq',
    rejectUnauthorized:true,timeout:5000});
  try {
    const channel=await connection.createChannel();
    await channel.assertExchange('cab.payment.events','topic',{durable:true});
    await channel.assertQueue('cab.notification.v2',{
      durable:true,arguments:{'x-queue-type':'quorum'}});
    await channel.bindQueue('cab.notification.v2','cab.payment.events','notification.v2.*');
    await channel.close();
  } finally {await connection.close();}
  const verify=new URL('amqps://cab_payment_publisher@rabbitmq:5671/%2Fcab');
  verify.password=payment;
  const publisher=await amqp.connect(verify.toString(),{
    ca:readFileSync('/cab-pki/ca.crt'),servername:'rabbitmq',
    rejectUnauthorized:true,timeout:5000});
  await publisher.close();
  console.info('Payment publisher ACL and Notification binding verified.');
} catch {
  console.error('Payment broker setup failed; inspect scoped ACL and AMQPS topology.');
  process.exitCode=1;
}
