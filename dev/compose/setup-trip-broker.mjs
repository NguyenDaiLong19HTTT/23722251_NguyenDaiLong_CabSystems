// Add only the Trip publisher to the existing demo vhost and Notification queue.
import {readFileSync} from 'node:fs';
import amqp from 'amqplib';

const read=name=>readFileSync(`/cab-runtime/${name}`,'utf8').trim();
const admin=read('rabbit_admin_password'),password=read('rabbit_trip_password');
const auth='Basic '+Buffer.from(`cab_dev_admin:${admin}`).toString('base64');
const request=async(path,method,body)=>{
  const response=await fetch(`http://rabbitmq:15672/api/${path}`,{
    method,headers:{Authorization:auth,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  if(!response.ok) throw new Error(`Trip broker setup failed (${response.status})`);
  return response;
};
try {
  const existing=await fetch('http://rabbitmq:15672/api/users/cab_trip_publisher',{
    headers:{Authorization:auth},signal:AbortSignal.timeout(5000)});
  if(existing.status===404) await request('users/cab_trip_publisher','PUT',{password,tags:''});
  else if(!existing.ok) throw new Error(`Trip broker user check failed (${existing.status})`);
  await request('permissions/%2Fcab/cab_trip_publisher','PUT',{
    configure:'^$',write:'^cab\\.trip\\.events$',read:'^$'});
  await request('topic-permissions/%2Fcab/cab_trip_publisher','PUT',{
    exchange:'cab.trip.events',write:'^notification\\.v2\\.TRIP_(STARTED|COMPLETED|CANCELLED|ERROR|RECOVERED|CLOSED_ABNORMALLY)$|^notification\\.v2\\.DRIVER_ARRIVED$',read:'^$'});
  const url=new URL('amqps://cab_dev_admin@rabbitmq:5671/%2Fcab');url.password=admin;
  const connection=await amqp.connect(url.toString(),{ca:readFileSync('/cab-pki/ca.crt'),
    servername:'rabbitmq',rejectUnauthorized:true,timeout:5000});
  try {const channel=await connection.createChannel();
    await channel.assertExchange('cab.trip.events','topic',{durable:true});
    await channel.assertQueue('cab.notification.v2',{
      durable:true,arguments:{'x-queue-type':'quorum'}});
    await channel.bindQueue('cab.notification.v2','cab.trip.events','notification.v2.*');
    await channel.close();}
  finally {await connection.close();}
  const verify=new URL('amqps://cab_trip_publisher@rabbitmq:5671/%2Fcab');
  verify.password=password;
  const publisher=await amqp.connect(verify.toString(),{ca:readFileSync('/cab-pki/ca.crt'),
    servername:'rabbitmq',rejectUnauthorized:true,timeout:5000});
  await publisher.close();
  console.info('Trip publisher ACL and Notification binding verified.');
} catch {console.error('Trip broker setup failed; inspect scoped ACL and AMQPS topology.');
  process.exitCode=1;}
