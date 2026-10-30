import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';

type Purpose = 'contact' | 'snapshot' | 'lookup' | 'idempotency' | 'fingerprint' |
  'recovery' | 'refresh' | 'receipt' | 'jwt' | 'otp' | 'verification';
const purposes: Purpose[] = ['contact','snapshot','lookup','idempotency','fingerprint',
  'recovery','refresh','receipt','jwt','otp','verification'];
export interface Sealed { ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array; keyVersion: string }

// Every purpose has its own stable 256-bit key. Paths point only to local ignored files.
@Injectable()
export class IdentityCrypto {
  private readonly keys = new Map<Purpose, Buffer>();
  readonly version = 'local-v1';
  readonly issuer = 'cab.local';
  readonly audience = 'cab-api';

  constructor() {
    for (const purpose of purposes) {
      const path = process.env[`CAB_IDENTITY_${purpose.toUpperCase()}_KEY_FILE`];
      if (!path) throw new Error('Identity cryptographic configuration is missing');
      let key: Buffer;
      try { key = Buffer.from(readFileSync(path,'utf8').trim(),'base64url'); }
      catch { throw new Error('Identity cryptographic configuration is invalid'); }
      if (key.length !== 32) throw new Error('Identity cryptographic configuration is invalid');
      this.keys.set(purpose,key);
    }
  }

  private key(purpose: Purpose): Buffer { return this.keys.get(purpose)!; }
  digest(purpose: Exclude<Purpose,'contact'|'snapshot'|'jwt'>, value: string): Buffer {
    return createHmac('sha256',this.key(purpose)).update(`cab:${purpose}:v1\0`).update(value,'utf8').digest();
  }
  matches(purpose: Exclude<Purpose,'contact'|'snapshot'|'jwt'>, value: string, expected: Uint8Array): boolean {
    const actual = this.digest(purpose,value);
    return expected.length === actual.length && timingSafeEqual(actual,Buffer.from(expected));
  }
  seal(purpose: 'contact'|'snapshot'|'otp', value: string, context: string): Sealed {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',this.key(purpose),nonce);
    cipher.setAAD(Buffer.from(`cab:${purpose}:v1\0${context}`));
    return { ciphertext:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]),
      nonce,tag:cipher.getAuthTag(),keyVersion:this.version };
  }
  open(purpose: 'contact'|'snapshot'|'otp', sealed: Sealed, context: string): string {
    if (sealed.keyVersion !== this.version) throw new Error('Unsupported key version');
    const decipher = createDecipheriv('aes-256-gcm',this.key(purpose),sealed.nonce);
    decipher.setAAD(Buffer.from(`cab:${purpose}:v1\0${context}`));
    decipher.setAuthTag(Buffer.from(sealed.tag));
    return Buffer.concat([decipher.update(sealed.ciphertext),decipher.final()]).toString('utf8');
  }
  hashPassword(password: string): Promise<string> {
    return argon2.hash(password,{type:argon2.argon2id});
  }
  verifyPassword(hash: string,password: string): Promise<boolean> {
    return argon2.verify(hash,password);
  }
  token(): string { return randomBytes(32).toString('base64url'); }
  async signAccess(accountId:string,sessionId:string,expiry:Date): Promise<string> {
    return new SignJWT({ sid:sessionId }).setProtectedHeader({alg:'HS256',typ:'JWT'})
      .setIssuer(this.issuer).setAudience(this.audience).setSubject(accountId)
      .setIssuedAt().setNotBefore('0s').setExpirationTime(Math.floor(expiry.getTime()/1000))
      .sign(this.key('jwt'));
  }
  async verifyAccess(token:string): Promise<{accountId:string;sessionId:string}> {
    const {payload} = await jwtVerify(token,this.key('jwt'),{
      algorithms:['HS256'],issuer:this.issuer,audience:this.audience,requiredClaims:['exp','nbf','sid','sub'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
      throw new Error('Invalid access token');
    return {accountId:payload.sub,sessionId:payload.sid};
  }
}
