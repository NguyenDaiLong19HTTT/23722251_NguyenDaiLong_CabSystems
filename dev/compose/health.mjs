import {X509Certificate} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {MongoClient} from 'mongodb';
import amqp from 'amqplib';
import {createClient} from '../../packages/grpc-transport/dist/index.js';
import {validateWorkload} from './cert-policy.mjs';

const service=process.argv[2];
const secret=name=>readFileSync(`/cab-runtime/${name}`,'utf8').trim();
const address={identity:50061,customer:50062,driver:50063,notification:50064,
  payment:50065,booking:50066,trip:50067,rating:50068}[service];
const requiredWorkers={identity:['customer-recovery','driver-recovery'],
  driver:['driver-outbox','location-handoff'],notification:['notification-delivery'],
  payment:['payment-outbox'],booking:['booking-dispatch','booking-outbox'],
  trip:['trip-closure','trip-outbox']};
const withTimeout=async(promise,ms)=>{
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>
    {timer=setTimeout(()=>reject(new Error('Health timeout')),ms);})]);}
  finally {clearTimeout(timer);}
};
async function database() {
  if (!['identity','customer','driver','payment','trip','booking','rating'].includes(service)) return;
  const url=new URL('postgresql://localhost/');
  url.hostname='postgres';url.port='5432';url.username=`${service}_runtime`;
  url.password=secret(`${service}_runtime_password`);url.pathname=`/cab_${service}`;
  const client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:2500});
  try {await client.connect();await client.query('SELECT 1');}
  finally {await client.end().catch(()=>undefined);}
}
async function broker() {
  if (!['driver','notification','payment','trip','booking'].includes(service)) return;
  const url=new URL('amqps://localhost/%2Fcab');
  url.hostname='rabbitmq';url.port='5671';
  url.username=service==='driver'?'cab_driver_publisher':
    service==='payment'?'cab_payment_publisher':
    service==='trip'?'cab_trip_publisher':
    service==='booking'?'cab_booking_publisher':'cab_notification_consumer';
  url.password=secret(`rabbit_${service}_password`);
  const connection=await amqp.connect(url.toString(),{
    ca:readFileSync('/cab-pki/ca.crt'),servername:'rabbitmq',rejectUnauthorized:true,timeout:2500});
  await connection.close();
}
async function mongo() {
  if (service!=='notification') return;
  const url=new URL('mongodb://localhost/cab_notification');
  url.hostname='mongo';url.port='27017';url.username='notification_runtime';
  url.password=secret('mongo_notification_password');
  const client=new MongoClient(url.toString(),{serverSelectionTimeoutMS:2500});
  try {await client.connect();await client.db('cab_notification').command({ping:1});}
  finally {await client.close();}
}
async function listener() {
  if (service==='gateway') {
    const response=await fetch('http://127.0.0.1:33201/v1/accounts/me',
      {signal:AbortSignal.timeout(2500)});
    if (![401,403].includes(response.status)) throw new Error('Gateway auth route unavailable');
    const tls={ca:readFileSync('/cab-pki/ca.crt'),
      cert:readFileSync('/cab-pki/gateway.crt'),key:readFileSync('/cab-pki/gateway.key')};
    validateWorkload(tls.cert,{name:'gateway',ca:tls.ca,key:tls.key,
      minimumRemainingMs:60000});
    await Promise.all(Object.entries({identity:50061,customer:50062,driver:50063,
      notification:50064,payment:50065,booking:50066,trip:50067,rating:50068}).map(async([name,port])=>{
      const client=createClient(`${name}-service:${port}`,tls,`${name}-service`);
      try {await new Promise((resolve,reject)=>client.waitForReady(Date.now()+2500,
        error=>error?reject(error):resolve()));}
      finally {client.close();}
    }));
    return;
  }
  const tls={ca:readFileSync('/cab-pki/ca.crt'),
    cert:readFileSync(`/cab-pki/${service}.crt`),
    key:readFileSync(`/cab-pki/${service}.key`)};
  validateWorkload(tls.cert,{name:service,ca:tls.ca,key:tls.key,
    minimumRemainingMs:60000});
  const client=createClient(`127.0.0.1:${address}`,tls,`${service}-service`);
  try {await new Promise((resolve,reject)=>client.waitForReady(Date.now()+2500,
    error=>error?reject(error):resolve()));}
  finally {client.close();}
}
function workers() {
  for (const name of requiredWorkers[service]??[]) {
    const stamp=Number(readFileSync(`/cab-health/${service}-${name}`,'utf8'));
    if (!Number.isFinite(stamp)||stamp>Date.now()+1000||Date.now()-stamp>25000)
      throw new Error('Worker heartbeat stale');
  }
}
async function certificates() {
  const ca=readFileSync('/run/secrets/cab_ca_cert');
  for (const name of ['gateway','identity','customer','driver','notification','payment',
    'booking','trip','rating','broker']) {
    const bytes=readFileSync(`/out/${name}/${name}.crt`);
    const cert=new X509Certificate(bytes);
    if (Date.now()<Date.parse(cert.validFrom)||Date.now()+3600000>=Date.parse(cert.validTo))
      throw new Error('Certificate nearing expiry');
    if(name!=='broker') validateWorkload(bytes,{name,ca,
      key:readFileSync(`/out/${name}/${name}.key`),minimumRemainingMs:3600000});
  }
}
if (service==='certs') {
  try {await certificates();} catch {console.error('CAB certificates are not ready');process.exitCode=1;}
} else {
  const checks=[['listener',listener]];
  if (['identity','customer','driver','payment','trip','booking','rating'].includes(service))
    checks.push(['database',database]);
  if (['driver','notification','payment','trip','booking'].includes(service))
    checks.push(['broker',broker]);
  if (service==='notification') checks.push(['mongo',mongo]);
  if (requiredWorkers[service]) checks.push(['workers',workers]);
  const results=await Promise.all(checks.map(async([name,probe])=>{
    try {await withTimeout(Promise.resolve().then(probe),5000);return [name,true];}
    catch {return [name,false];}
  }));
  const healthy=results.every(([,ok])=>ok);
  try {writeFileSync(`/cab-health/${service}-probe.json`,JSON.stringify({
    checkedAt:Date.now(),checks:Object.fromEntries(results)}));}
  catch {process.exitCode=1;}
  if (!healthy) {console.error('CAB service is not ready');process.exitCode=1;}
}
