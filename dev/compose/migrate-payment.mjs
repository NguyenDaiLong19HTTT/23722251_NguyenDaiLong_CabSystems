import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import pg from 'pg';

const raw=process.env.CAB_PAYMENT_MIGRATION_URL;
if (!raw) throw new Error('Payment migration URL missing');
const url=new URL(raw);
if (url.username!=='payment_migration'||url.pathname!=='/cab_payment')
  throw new Error('Payment migration role/database mismatch');
const folder=new URL('../../services/payment-service/src/infrastructure/migrations/',import.meta.url);
const files=readdirSync(folder).filter(name=>/^\d{12}_[a-z0-9_]+\.sql$/.test(name)).sort();
if (!files.length) throw new Error('Payment migrations missing');
const db=new pg.Client({connectionString:raw,connectionTimeoutMillis:5000});
try {
  await db.connect();
  for (const filename of files) {
    const sql=readFileSync(new URL(filename,folder),'utf8');
    const checksum=createHash('sha256').update(sql).digest('hex');
    await db.query('BEGIN');
    try {
      await db.query(`CREATE TABLE IF NOT EXISTS payment_schema_migrations
        (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const prior=await db.query('SELECT checksum FROM payment_schema_migrations WHERE name=$1',[filename]);
      if (prior.rows[0]) {
        if (prior.rows[0].checksum!==checksum)
          throw new Error('Applied Payment migration checksum differs');
        console.info(`${filename}: checksum verified.`);
      } else {
        await db.query(sql);
        await db.query('INSERT INTO payment_schema_migrations(name,checksum) VALUES($1,$2)',[
          filename,checksum]);
        console.info(`${filename}: applied.`);
      }
      await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK').catch(()=>undefined);throw error;}
  }
} catch(error) {
  console.error('Payment migration failed; transaction rolled back.');
  process.exitCode=1;
  if (error instanceof Error&&/checksum/.test(error.message)) console.error(error.message);
} finally {await db.end().catch(()=>undefined);}
