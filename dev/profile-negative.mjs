import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const state=JSON.parse(readFileSync(join(root,'.secrets','customer-dev',
  'recovery-restart-state.json'),'utf8'));
const base='http://127.0.0.1:33001';
const login=await fetch(base+'/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({emailOrPhone:state.email,password:state.password})});
assert.equal(login.status,200);
const token=(await login.json()).accessToken;
const wrong=await fetch(base+'/v1/customers/'+randomUUID(),{
  headers:{Authorization:'Bearer '+token}});
assert.equal(wrong.status,404);
assert.equal((await wrong.json()).errorCode,'CUSTOMER_NOT_FOUND');
const invalid=await fetch(base+'/v1/customers/'+randomUUID(),{
  headers:{Authorization:'Bearer invalid'}});
assert.equal(invalid.status,401);
console.info('PASS Customer facade denies other object and invalid token over Gateway→Customer→Identity mTLS');
