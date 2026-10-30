import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {MongoClient} from 'mongodb';

const root=fileURLToPath(new URL('../../',import.meta.url));
const folder=join(root,'.secrets','customer-dev');
const backup=join(root,'.secrets','cab-cutover-backups');
mkdirSync(backup,{recursive:true});
const read=name=>readFileSync(join(folder,name),'utf8').trim();
const safe=name=>'"'+name.replaceAll('"','""')+'"';
const result={time:new Date().toISOString(),postgres:{},mongo:{}};
try {
  for (const service of ['identity','customer','driver']) {
    const url=new URL('postgresql://localhost/');
    url.hostname='127.0.0.1';url.port='55439';
    url.username=`${service}_runtime`;url.password=read(`${service}_runtime_password`);
    url.pathname=`/cab_${service}`;
    const client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
    try {
      await client.connect();
      const tables=await client.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
      const serviceCounts={};
      for (const {table_name:name} of tables.rows) {
        const count=await client.query(`SELECT count(*)::int AS n FROM ${safe(name)}`);
        const entry={count:count.rows[0].n};
        const status=await client.query(`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1
            AND column_name IN ('status','state','account_status','review_status','availability_status')
          ORDER BY CASE column_name WHEN 'status' THEN 0 WHEN 'account_status' THEN 1 ELSE 2 END`,[name]);
        if (status.rows.length) {
          const column=status.rows[0].column_name;
          const groups=await client.query(`SELECT ${safe(column)}::text AS state,
            count(*)::int AS n FROM ${safe(name)} GROUP BY 1 ORDER BY 1`);
          entry.states=Object.fromEntries(groups.rows.map(row=>[row.state,row.n]));
        }
        serviceCounts[name]=entry;
      }
      result.postgres[service]=serviceCounts;
    } finally {await client.end().catch(()=>undefined);}
  }
  const mongo=new URL('mongodb://localhost/cab_notification');
  mongo.hostname='127.0.0.1';mongo.port='55440';mongo.username='notification_runtime';
  mongo.password=read('mongo_notification_password');
  const client=new MongoClient(mongo.toString(),{serverSelectionTimeoutMS:5000});
  try {
    await client.connect();
    for (const name of ['notifications','inbox_jobs','quarantine_outbox'])
      result.mongo[name]=await client.db('cab_notification').collection(name).countDocuments();
    const duplicates=await client.db('cab_notification').collection('notifications').aggregate([
      {$group:{_id:{eventId:'$eventId',recipientAccountId:'$recipientAccountId',
        channel:'$channel'},count:{$sum:1}}},{$match:{count:{$gt:1}}},{$count:'groups'},
    ]).toArray();
    result.mongo.duplicateEventRecipientGroups=duplicates[0]?.groups??0;
  } finally {await client.close();}
  const path=join(backup,`baseline-${process.argv[2]??'current'}.json`);
  writeFileSync(path,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.info(JSON.stringify({path,counts:result}));
} catch {
  console.error('CAB baseline failed; no credential or URL printed');
  process.exitCode=1;
}
