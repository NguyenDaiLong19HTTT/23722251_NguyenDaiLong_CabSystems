import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {MongoClient} from 'mongodb';

const local='.secrets/customer-dev/';
const read=name=>readFileSync(local+name,'utf8').trim();
const fixture=JSON.parse(read(process.argv[3]==='rejected'
  ?'driver_registration_reject_smoke.json':'driver_registration_smoke.json'));
const eventType=process.argv[3]==='rejected'
  ?'DRIVER_APPLICATION_REJECTED':'DRIVER_APPLICATION_APPROVED';
const url=new URL('postgresql://driver_runtime@127.0.0.1:55439/cab_driver');
url.password=read('driver_runtime_password');
const db=new pg.Client({connectionString:url.toString()});
const mongoUrl=new URL('mongodb://notification_runtime@127.0.0.1:55441/cab_notification');
mongoUrl.password=read('mongo_notification_password');
const mongo=new MongoClient(mongoUrl.toString(),{serverSelectionTimeoutMS:3000});
try {
  await db.connect();
  const phase=process.argv[2];
  if (phase==='unpublished') {
    const rows=await db.query(`SELECT event_id,published_at FROM driver_application_outbox
      WHERE application_id=$1::uuid AND event_type=$2`,[fixture.applicationId,eventType]);
    assert.equal(rows.rowCount,1,'one committed review event');
    assert.equal(rows.rows[0].published_at,null,'broker outage keeps event unpublished');
    console.info('PASS broker outage: review committed one durable, unpublished outbox event');
  } else if (phase==='published') {
    let published=false;
    for(let i=0;i<100;i++) {
      const rows=await db.query(`SELECT published_at FROM driver_application_outbox
        WHERE application_id=$1::uuid AND event_type=$2`,[fixture.applicationId,eventType]);
      assert.equal(rows.rowCount,1,'one committed review event');
      if(rows.rows[0].published_at) {published=true;break;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(published,'publisher confirm while MongoDB unavailable');
    console.info('PASS MongoDB outage: review event confirmed to RabbitMQ while consumer store unavailable');
  } else if (phase==='delivered') {
    await mongo.connect();
    let passed=false;
    let last;
    for(let i=0;i<240;i++) {
      const rows=await db.query(`SELECT event_id,published_at,attempts,next_attempt_at
        FROM driver_application_outbox
        WHERE application_id=$1::uuid AND event_type=$2`,[fixture.applicationId,eventType]);
      assert.equal(rows.rowCount,1);
      const row=rows.rows[0];
      last={published:!!row.published_at,attempts:row.attempts,
        nextAttemptAt:row.next_attempt_at};
      const notices=await mongo.db('cab_notification').collection('notifications')
        .find({eventId:row.event_id,recipientAccountId:fixture.accountId,
          eventType,channel:'IN_APP'}).toArray();
      assert.ok(notices.length<=1,'dedupe across recovery');
      if(row.published_at&&notices.length===1) {passed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(passed,'recovered broker/consumer must publish one notification: '+
      JSON.stringify(last));
    console.info('PASS harness recovery: outbox confirmed and one durable Notification');
  } else throw new Error('Use unpublished|published|delivered [rejected]');
} finally {
  await mongo.close().catch(()=>undefined);
  await db.end().catch(()=>undefined);
}
