import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root=fileURLToPath(new URL('../',import.meta.url));
const password=readFileSync(join(root,'.secrets','customer-dev','driver_migration_password'),'utf8').trim();
const db=new pg.Client({connectionString:`postgresql://driver_migration:${password}@127.0.0.1:55439/cab_driver`});
await db.connect();
try {
  const result=await db.query(`SELECT migration_name,finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS rolled_back,logs FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1`);
  console.info(result.rows[0]);
  const objects=await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename IN ('driver_profile','vehicle','vehicle_assignment','availability_receipt',
      'driver_location','driver_location_sample')`);
  console.info('Driver tables after failed deploy:',objects.rows.map(row=>row.tablename));
  const migration=readFileSync(join(root,'services','driver-service','src','infrastructure',
    'prisma','migrations','202610030001_driver_demo','migration.sql'),'utf8')
    .replace(/COMMIT;\s*$/,'ROLLBACK;');
  try {await db.query(migration);console.info('Migration SQL parsed in rolled-back diagnostic transaction');}
  catch(error) {console.info('Diagnostic SQL error:',error.code,error.message);await db.query('ROLLBACK');}
} finally {await db.end();}
