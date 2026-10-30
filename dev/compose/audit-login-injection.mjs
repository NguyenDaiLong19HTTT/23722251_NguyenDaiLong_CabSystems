// Run inside identity-service with node -; no real credentials are printed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
const url=new URL('postgresql://localhost/cab_identity');
url.hostname='postgres';url.port='5432';url.username='identity_runtime';
url.password=readFileSync('/cab-runtime/identity_runtime_password','utf8').trim();
const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:2500});
async function counts() {
  const result=await db.query(`SELECT
    (SELECT count(*)::int FROM account) AS accounts,
    (SELECT count(*)::int FROM session) AS sessions`);
  return result.rows[0];
}
try {
  await db.connect();
  const before=await counts();
  const statuses=[];
  for(const emailOrPhone of ["' OR 1=1 --","a'OR1=1--@example.test"]) {
    const response=await fetch('http://api-gateway:33201/v1/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({emailOrPhone,password:'synthetic-only'}),
      signal:AbortSignal.timeout(4000)});
    assert.ok([400,401].includes(response.status));
    const result=await response.json();
    assert.ok(['VALIDATION_ERROR','INVALID_CREDENTIALS'].includes(result.errorCode));
    statuses.push(response.status);
  }
  assert.deepEqual(await counts(),before,'login injection must not create Account/Session');
  console.info(JSON.stringify({statuses,accountAndSessionCountsUnchanged:true}));
} finally {await db.end().catch(()=>undefined);}
