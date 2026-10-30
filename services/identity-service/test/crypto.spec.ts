import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityCrypto } from '../src/infrastructure/crypto.js';

const purposes=['contact','snapshot','lookup','idempotency','fingerprint','recovery','refresh','receipt','jwt','otp','verification'];
let directory:string;
beforeEach(() => {
  directory=mkdtempSync(join(tmpdir(),'cab-identity-crypto-test-'));
  for (const purpose of purposes) {
    const file=join(directory,purpose+'.key');
    writeFileSync(file,randomBytes(32).toString('base64url'));
    process.env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`]=file;
  }
});
afterEach(() => {
  for (const purpose of purposes) delete process.env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`];
  rmSync(directory,{recursive:true,force:true});
});
it('Argon2id verifies exact password without trimming; AES-GCM binds key and context',async()=>{
  const crypto=new IdentityCrypto();
  const hash=await crypto.hashPassword('  Correct horse battery  ');
  expect(hash.startsWith('$argon2id$')).toBe(true);
  expect(await crypto.verifyPassword(hash,'  Correct horse battery  ')).toBe(true);
  expect(await crypto.verifyPassword(hash,'Correct horse battery')).toBe(false);
  const sealed=crypto.seal('contact','user@example.com','account:email');
  expect(crypto.open('contact',sealed,'account:email')).toBe('user@example.com');
  expect(()=>crypto.open('contact',sealed,'different:email')).toThrow();
  expect(()=>crypto.open('snapshot',sealed,'account:email')).toThrow();
  const modified={...sealed,tag:Uint8Array.from(sealed.tag)};
  modified.tag[0]!^=1;
  expect(()=>crypto.open('contact',modified,'account:email')).toThrow();
  expect(readFileSync(process.env.CAB_IDENTITY_CONTACT_KEY_FILE!,'utf8').length).toBeGreaterThan(30);
});
it('purpose-separated HMAC and JWT enforce issuer, audience, signature and expiry',async()=>{
  const crypto=new IdentityCrypto();
  expect(crypto.matches('recovery','token',crypto.digest('recovery','token'))).toBe(true);
  expect(crypto.matches('refresh','token',crypto.digest('recovery','token'))).toBe(false);
  const valid=await crypto.signAccess('account','session',new Date(Date.now()+60000));
  expect(await crypto.verifyAccess(valid)).toEqual({accountId:'account',sessionId:'session'});
  const parts=valid.split('.');
  expect(parts).toHaveLength(3);
  parts[2]=(parts[2]![0]==='A'?'B':'A')+parts[2]!.slice(1);
  await expect(crypto.verifyAccess(parts.join('.'))).rejects.toThrow();
  await expect(crypto.verifyAccess(await crypto.signAccess('a','b',new Date(Date.now()-1000))))
    .rejects.toThrow();
});
it('missing or malformed key fails closed without exposing its value',()=>{
  delete process.env.CAB_IDENTITY_CONTACT_KEY_FILE;
  expect(()=>new IdentityCrypto()).toThrow('configuration is missing');
  process.env.CAB_IDENTITY_CONTACT_KEY_FILE=join(directory,'contact.key');
  writeFileSync(process.env.CAB_IDENTITY_CONTACT_KEY_FILE,'invalid');
  expect(()=>new IdentityCrypto()).toThrow('configuration is invalid');
});
