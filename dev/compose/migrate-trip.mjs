import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import pg from 'pg';

const raw=process.env.CAB_TRIP_MIGRATION_URL;
if(!raw) throw new Error('Trip migration URL missing');
const url=new URL(raw);
if(url.username!=='trip_migration'||url.pathname!=='/cab_trip')
  throw new Error('Trip migration role/database mismatch');
const folder=new URL('../../services/trip-service/src/infrastructure/migrations/',import.meta.url);
const files=readdirSync(folder).filter(name=>/^\d{12}_[a-z0-9_]+\.sql$/.test(name)).sort();
if(!files.length) throw new Error('Trip migrations missing');
const db=new pg.Client({connectionString:raw,connectionTimeoutMillis:5000});
try {
  await db.connect();
  for(const name of files) {
    const sql=readFileSync(new URL(name,folder),'utf8');
    const checksum=createHash('sha256').update(sql).digest('hex');
    await db.query('BEGIN');
    try {
      await db.query(`CREATE TABLE IF NOT EXISTS trip_schema_migrations
        (name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const prior=await db.query('SELECT checksum FROM trip_schema_migrations WHERE name=$1',[name]);
      if(prior.rows[0]) {
        if(prior.rows[0].checksum!==checksum) throw new Error('Applied Trip migration checksum differs');
        console.info(`${name}: checksum verified.`);
      } else {
        await db.query(sql);
        await db.query('INSERT INTO trip_schema_migrations(name,checksum) VALUES($1,$2)',[
          name,checksum]);
        console.info(`${name}: applied.`);
      }
      await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK').catch(()=>undefined);throw error;}
  }
} catch(error) {
  console.error('Trip migration failed; transaction rolled back.');
  if(error instanceof Error&&/checksum/.test(error.message)) console.error(error.message);
  process.exitCode=1;
} finally {await db.end().catch(()=>undefined);}
