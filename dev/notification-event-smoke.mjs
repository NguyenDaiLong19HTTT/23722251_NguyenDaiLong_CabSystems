import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import amqp from 'amqplib';
import {MongoClient} from 'mongodb';
import pg from 'pg';

const root=fileURLToPath(new URL('../',import.meta.url));
const local=join(root,'.secrets','customer-dev');
const read=name=>readFileSync(join(local,name),'utf8').trim();
const fixture=JSON.parse(read('driver_registration_smoke.json'));
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const driverUrl=new URL('postgresql://driver_runtime@127.0.0.1:55439/cab_driver');
driverUrl.password=read('driver_runtime_password');
const db=new pg.Client({connectionString:driverUrl.toString()});
const mongoUrl=new URL('mongodb://notification_runtime@127.0.0.1:55440/cab_notification');
mongoUrl.password=read('mongo_notification_password');
const mongo=new MongoClient(mongoUrl.toString(),{serverSelectionTimeoutMS:3000});
const amqpUrl=new URL('amqps://cab_driver_publisher@127.0.0.1:56791/%2Fcab');
amqpUrl.password=read('rabbit_driver_password');
let broker;
try {
  await db.connect();await mongo.connect();
  const result=await db.query(`SELECT o.event_id,o.application_id,o.aggregate_version,
    o.event_type,o.created_at,a.account_id,a.operation_id,a.rejection_reason
    FROM driver_application_outbox o JOIN driver_application a
      ON a.application_id=o.application_id
    WHERE o.application_id=$1::uuid AND o.event_type='DRIVER_APPLICATION_APPROVED'`,
  [fixture.applicationId]);
  assert.equal(result.rowCount,1,'one approved review event');
  const row=result.rows[0];
  assert.ok((await db.query('SELECT published_at FROM driver_application_outbox WHERE event_id=$1',
    [row.event_id])).rows[0].published_at,'publisher confirm persisted');
  const event={schemaVersion:2,eventId:row.event_id,source:'DRIVER_SERVICE',
    eventType:row.event_type,aggregateType:'DRIVER_APPLICATION',
    aggregateId:row.application_id,aggregateVersion:Number(row.aggregate_version),
    referenceType:'DRIVER_APPLICATION',referenceId:row.application_id,
    recipientAccountIds:[row.account_id],snapshot:{},
    occurredAt:row.created_at.toISOString(),correlationId:row.operation_id};
  const notices=mongo.db('cab_notification').collection('notifications');
  const inbox=mongo.db('cab_notification').collection('inbox_jobs');
  const quarantine=mongo.db('cab_notification').collection('quarantine_outbox');
  const before=await notices.findOne({eventId:row.event_id,recipientAccountId:row.account_id});
  assert.ok(before?.isRead&&before.readAt,'notification already read before replay');
  broker=await amqp.connect(amqpUrl.toString(),{ca:readFileSync(join(local,'pki','ca.crt')),
    servername:'localhost',rejectUnauthorized:true,timeout:4000});
  const channel=await broker.createConfirmChannel();
  const publish=(body,properties)=>new Promise((resolve,reject)=>{
    channel.publish('cab.driver.events','notification.v2.DRIVER_APPLICATION_APPROVED',
      body,{mandatory:true,persistent:true,contentType:'application/json',
        contentEncoding:'utf-8',messageId:row.event_id,
        type:'DRIVER_APPLICATION_APPROVED',correlationId:row.operation_id,
        headers:{'cab-schema-version':2},...properties},
      error=>error?reject(error):resolve());
  });
  await publish(Buffer.from(JSON.stringify(event)));
  await publish(Buffer.from(JSON.stringify(event)));
  let status;
  for (let i=0;i<30;i++) {
    const job=await inbox.findOne({_id:row.event_id});
    const count=await notices.countDocuments({eventId:row.event_id,
      recipientAccountId:row.account_id,channel:'IN_APP'});
    status=job?.status;
    if (status==='DONE'&&count===1) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(status,'DONE');
  assert.equal(await notices.countDocuments({eventId:row.event_id,
    recipientAccountId:row.account_id,channel:'IN_APP'}),1,'duplicate delivery creates one notice');
  const after=await notices.findOne({_id:before._id});
  assert.equal(after.readAt.toISOString(),before.readAt.toISOString(),'replay retains readAt');
  const invalidMessageId='malformed-'+randomUUID();
  const malformed=Buffer.from('{invalid-json-'+invalidMessageId);
  await publish(malformed,{messageId:invalidMessageId});
  const invalidId=await (async()=>{
    for(let i=0;i<50;i++) {
      const found=await quarantine.findOne({reason:'EVENT_PARSE_INVALID',
        'properties.messageId':invalidMessageId});
      if(found?.publishedAt) return found._id;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    const found=await quarantine.findOne({'properties.messageId':invalidMessageId},
      {projection:{reason:1,attempts:1,publishedAt:1}});
    throw new Error('Malformed message not durably quarantined and DLQ published: '+
      JSON.stringify(found??{missing:true}));
  })();
  assert.ok(invalidId);
  const login=await fetch(base+'/v1/auth/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({
      emailOrPhone:fixture.email,password:fixture.password})});
  assert.equal(login.status,200);
  const token=(await login.json()).accessToken;
  const response=await fetch(base+'/v1/notifications?isRead=true',{
    headers:{Authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  assert.ok((await response.json()).items.some(item=>item.notificationId===before._id));
  console.info('PASS Notification replay: confirm, duplicate event, stable readAt, malformed quarantine and DLQ');
} finally {
  await broker?.close().catch(()=>undefined);
  await mongo.close().catch(()=>undefined);
  await db.end().catch(()=>undefined);
}
