import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {MongoClient} from 'mongodb';

const root=fileURLToPath(new URL('../../',import.meta.url));
const local=join(root,'.secrets','customer-dev');
const flow=JSON.parse(readFileSync(join(root,'.secrets','cab-cutover-backups',
  'flow-runtime','driver_registration_smoke.json'),'utf8'));
const read=name=>readFileSync(join(local,name),'utf8').trim();
const response=await fetch('http://127.0.0.1:33201/v1/auth/login',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({
    emailOrPhone:flow.email,password:flow.password})});
assert.equal(response.status,200,'New Driver credential survived restart');
const token=(await response.json()).accessToken;
const list=await fetch('http://127.0.0.1:33201/v1/notifications?limit=100',
  {headers:{Authorization:`Bearer ${token}`}});
assert.equal(list.status,200);
const notices=(await list.json()).items.filter(item=>item.referenceId===flow.applicationId);
assert.equal(notices.length,2,'Submitted and approved notices survived restart');
const approved=notices.find(item=>item.eventType==='DRIVER_APPLICATION_APPROVED');
assert.ok(approved?.isRead&&approved.readAt,'Mark-read timestamp survived restart');

const pgUrl=new URL('postgresql://driver_runtime@127.0.0.1:55439/cab_driver');
pgUrl.password=read('driver_runtime_password');
const db=new pg.Client({connectionString:pgUrl.toString(),connectionTimeoutMillis:5000});
try {
  await db.connect();
  const rows=await db.query(`SELECT event_id,published_at FROM driver_application_outbox
    WHERE application_id=$1::uuid`,[flow.applicationId]);
  assert.equal(rows.rowCount,2);
  assert.ok(rows.rows.every(row=>row.published_at),'Both outbox rows were confirmed');
} finally {await db.end();}

const mongoUrl=new URL('mongodb://notification_runtime@127.0.0.1:55440/cab_notification');
mongoUrl.password=read('mongo_notification_password');
const client=new MongoClient(mongoUrl.toString(),{serverSelectionTimeoutMS:5000});
try {
  await client.connect();
  const store=client.db('cab_notification');
  const rows=await store.collection('notifications').find({referenceId:flow.applicationId},
    {projection:{eventId:1}}).toArray();
  assert.equal(rows.length,2);
  assert.equal(new Set(rows.map(row=>row.eventId)).size,2,'No duplicate notice for an event');
  for (const row of rows) {
    const job=await store.collection('inbox_jobs').findOne({_id:row.eventId},
      {projection:{status:1}});
    assert.equal(job?.status,'DONE');
  }
} finally {await client.close();}
console.info('PASS restart: credential, own/read Notification, two confirmed outbox rows, '+
  'two unique Mongo notices and completed inbox jobs');
