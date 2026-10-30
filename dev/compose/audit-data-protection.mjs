// Run inside identity-service or driver-service with node -; output flags only.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import pg from 'pg';
const service=process.env.CAB_AUDIT_SERVICE;
assert.ok(['identity','driver'].includes(service));
const url=new URL('postgresql://localhost/');
url.hostname='postgres';url.port='5432';url.username=service+'_runtime';
url.password=readFileSync('/cab-runtime/'+service+'_runtime_password','utf8').trim();
url.pathname='/cab_'+service;
const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:2500});
try {
  await db.connect();
  if(service==='identity') {
    const rows=await db.query(`SELECT password_hash,email_ciphertext,email_nonce,email_tag,
      phone_ciphertext,phone_nonce,phone_tag,email_lookup_hmac,phone_lookup_hmac
      FROM account WHERE full_name='CAB Booking Demo Customer'
      ORDER BY created_at DESC LIMIT 1`);
    assert.equal(rows.rows.length,1);
    const row=rows.rows[0];
    assert.match(row.password_hash,/^\$argon2id\$/);
    for(const kind of ['email','phone']) {
      assert.ok(row[kind+'_ciphertext'].length>0);
      assert.equal(row[kind+'_nonce'].length,12);
      assert.equal(row[kind+'_tag'].length,16);
      assert.equal(row[kind+'_lookup_hmac'].length,32);
    }
    console.info(JSON.stringify({service,passwordArgon2id:true,
      emailAndPhoneCiphertextNonceTag:true,lookupHmac:true,
      keyMountedOutsideDatabase:existsSync('/cab-runtime/identity_contact_key')}));
  } else {
    const rows=await db.query(`SELECT license_ciphertext,license_nonce,license_tag,
      license_lookup_hmac FROM driver_profile ORDER BY created_at DESC LIMIT 1`);
    assert.equal(rows.rows.length,1);
    const row=rows.rows[0];
    assert.ok(row.license_ciphertext.length>0);
    assert.equal(row.license_nonce.length,12);
    assert.equal(row.license_tag.length,16);
    assert.equal(row.license_lookup_hmac.length,32);
    console.info(JSON.stringify({service,licenseCiphertextNonceTag:true,lookupHmac:true,
      keyMountedOutsideDatabase:existsSync('/cab-runtime/driver_license_key')}));
  }
} finally {await db.end().catch(()=>undefined);}
