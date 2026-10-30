import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root=fileURLToPath(new URL('../',import.meta.url)),folder=join(root,'.secrets','customer-dev');
const password=readFileSync(join(folder,'identity_runtime_password'),'utf8').trim();
const db=new pg.Client({connectionString:`postgresql://identity_runtime:${password}@127.0.0.1:55439/cab_identity`});
await db.connect();
try {
  const result=await db.query(`SELECT operation_id,public_status,internal_phase,
    customer_provision_state,terminal_error_code,updated_at FROM registration_operation
    WHERE flow_type='CUSTOMER' ORDER BY created_at DESC LIMIT 3`);
  console.info(result.rows);
  const steps=await db.query(`SELECT step_kind,step_state,attempt_count,last_safe_reason
    FROM registration_step WHERE operation_id=$1`,[result.rows[0]?.operation_id]);
  console.info(steps.rows);
} finally {await db.end();}
