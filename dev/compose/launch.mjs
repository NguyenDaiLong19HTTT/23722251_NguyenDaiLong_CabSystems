import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const mode=process.argv[2];
const names=['gateway','identity','customer','driver','notification','payment','trip','booking','rating'];
const migration=mode?.startsWith('migrate-');
const otp=mode==='otp';
const service=otp?'identity':migration?mode.slice(8):mode;
if (!names.includes(service)||migration&&!['identity','customer','driver','payment','trip','booking','rating'].includes(service))
  throw new Error('Invalid CAB Compose service');
if (otp&&!/^[0-9a-f-]{36}$/i.test(process.argv[3]??''))
  throw new Error('Valid challenge ID required');
const secret=name=>readFileSync(`/cab-runtime/${name}`,'utf8').trim();
const env={...process.env};
const pgUrl=(role)=>{
  const url=new URL('postgresql://localhost/');
  url.hostname='postgres';url.port='5432';
  url.username=`${service}_${role}`;
  url.password=secret(`${service}_${role}_password`);
  url.pathname=`/cab_${service}`;
  return url.toString();
};
if (migration) env[`CAB_${service.toUpperCase()}_MIGRATION_URL`]=pgUrl('migration');
else if (['identity','customer','driver','payment','trip','booking','rating'].includes(service))
  env[`CAB_${service.toUpperCase()}_RUNTIME_URL`]=pgUrl('runtime');
if (!migration) {
  const prefix=service==='gateway'?'API_GATEWAY':`${service.toUpperCase()}_SERVICE`;
  env[`${prefix}_CA_FILE`]=`/cab-pki/ca.crt`;
  env[`${prefix}_CERT_FILE`]=`/cab-pki/${service}.crt`;
  env[`${prefix}_KEY_FILE`]=`/cab-pki/${service}.key`;
  env.IDENTITY_SERVICE_GRPC_TARGET='identity-service:50061';
  env.CUSTOMER_SERVICE_GRPC_TARGET='customer-service:50062';
  env.DRIVER_SERVICE_GRPC_TARGET='driver-service:50063';
  env.NOTIFICATION_SERVICE_GRPC_TARGET='notification-service:50064';
  env.PAYMENT_SERVICE_GRPC_TARGET='payment-service:50065';
  env.BOOKING_SERVICE_GRPC_TARGET='booking-service:50066';
  env.TRIP_SERVICE_GRPC_TARGET='trip-service:50067';
  env.RATING_SERVICE_GRPC_TARGET='rating-service:50068';
  if (service==='gateway') {env.API_GATEWAY_HOST='0.0.0.0';env.API_GATEWAY_PORT='33201';}
  else env[`${prefix}_GRPC_BIND`]=`0.0.0.0:${{
    identity:50061,customer:50062,driver:50063,notification:50064,payment:50065,
    booking:50066,trip:50067,rating:50068}[service]}`;
  if (service==='identity') {
    env.CAB_DEV_OTP_ENABLED='1';
    for (const name of ['contact','snapshot','lookup','idempotency','fingerprint',
      'recovery','refresh','receipt','jwt','otp','verification'])
      env[`CAB_IDENTITY_${name.toUpperCase()}_KEY_FILE`]=`/cab-runtime/identity_${name}_key`;
  }
  if (service==='customer') env.CAB_CUSTOMER_RECEIPT_KEY_FILE='/cab-runtime/customer_receipt_key';
  if (service==='driver') {
    env.CAB_DRIVER_LICENSE_KEY_FILE='/cab-runtime/driver_license_key';
    env.CAB_DRIVER_APPLICATION_KEY_FILE='/cab-runtime/driver_application_key';
  }
  if (service==='payment') env.CAB_PAYMENT_CURSOR_KEY_FILE='/cab-runtime/payment_cursor_key';
  if (service==='trip') env.CAB_TRIP_CURSOR_KEY_FILE='/cab-runtime/trip_cursor_key';
  if (service==='booking') env.CAB_BOOKING_CURSOR_KEY_FILE='/cab-runtime/booking_cursor_key';
  if (service==='rating') env.CAB_RATING_CURSOR_KEY_FILE='/cab-runtime/rating_cursor_key';
  if (service==='notification') {
    env.CAB_NOTIFICATION_CURSOR_KEY_FILE='/cab-runtime/notification_cursor_key';
    env.CAB_NOTIFICATION_DLQ_KEY_FILE='/cab-runtime/notification_dlq_key';
    const mongo=new URL('mongodb://localhost/cab_notification');
    mongo.hostname='mongo';mongo.port='27017';mongo.username='notification_runtime';
    mongo.password=secret('mongo_notification_password');
    env.CAB_NOTIFICATION_MONGO_URL=mongo.toString();
  }
  if (['driver','notification','payment','trip','booking'].includes(service)) {
    const rabbit=new URL('amqps://localhost/%2Fcab');
    rabbit.hostname='rabbitmq';rabbit.port='5671';
    rabbit.username=service==='driver'?'cab_driver_publisher':
      service==='payment'?'cab_payment_publisher':
      service==='trip'?'cab_trip_publisher':
      service==='booking'?'cab_booking_publisher':'cab_notification_consumer';
    rabbit.password=secret(`rabbit_${service}_password`);
    env[service==='driver'?'CAB_DRIVER_AMQPS_URL':
      service==='payment'?'CAB_PAYMENT_AMQPS_URL':
      service==='trip'?'CAB_TRIP_AMQPS_URL':
      service==='booking'?'CAB_BOOKING_AMQPS_URL':'CAB_NOTIFICATION_AMQPS_URL']=rabbit.toString();
    env.CAB_RABBIT_CA_FILE='/cab-pki/ca.crt';
    env.CAB_RABBIT_TLS_SERVER_NAME='rabbitmq';
  }
}
const args=otp?['services/identity-service/dist/otp-dev-read.js',process.argv[3]]:
  migration&&['payment','trip','booking','rating'].includes(service)?[`dev/compose/migrate-${service}.mjs`]:
  migration?['node_modules/prisma/build/index.js','migrate','deploy',
  '--config',`services/${service}-service/src/infrastructure/prisma/prisma.config.ts`]:
  [`services/${service==='gateway'?'api-gateway':`${service}-service`}/dist/main.js`];
let stopping=false,child;
const fingerprint=()=>createHash('sha256')
  .update(readFileSync(`/cab-pki/${service}.crt`)).digest('hex');
let selected=migration?undefined:fingerprint();
const start=()=>{
  child=spawn(process.execPath,args,{cwd:'/app',env,stdio:'inherit'});
  child.once('exit',(code,signal)=>{
    if (stopping) {process.exitCode=code??0;return;}
    if (!migration) {
      const current=fingerprint();
      if (current!==selected) {selected=current;start();return;}
    }
    process.exitCode=code??(signal?1:0);
  });
};
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  stopping=true;child?.kill(signal);
});
start();
if (!migration) setInterval(()=>{
  if (stopping||!child||child.exitCode!==null) return;
  try {if (fingerprint()!==selected) child.kill('SIGTERM');}
  catch { /* Existing certificate remains active until issuer completes. */ }
},60000).unref();
