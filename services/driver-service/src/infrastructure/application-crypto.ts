import { createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class DriverApplicationCrypto {
  private readonly key:Buffer;
  readonly version='local-v1';
  constructor() {
    const path=process.env.CAB_DRIVER_APPLICATION_KEY_FILE;
    if (!path) throw new Error('Driver application key configuration is missing');
    try {this.key=Buffer.from(readFileSync(path,'utf8').trim(),'base64url');}
    catch {throw new Error('Driver application key configuration is invalid');}
    if (this.key.length!==32) throw new Error('Driver application key configuration is invalid');
  }
  digest(purpose:'provision'|'review',value:string):Buffer {
    return createHmac('sha256',this.key).update(`cab:driver:${purpose}:v1\0`).update(value).digest();
  }
  matches(purpose:'provision'|'review',value:string,expected:Uint8Array):boolean {
    const actual=this.digest(purpose,value);
    return actual.length===expected.length&&timingSafeEqual(actual,Buffer.from(expected));
  }
  seal(value:string,applicationId:string) {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    cipher.setAAD(Buffer.from(`cab:driver:application:v1\0${applicationId}`));
    return {ciphertext:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]),
      nonce,tag:cipher.getAuthTag(),keyVersion:this.version};
  }
  open(sealed:{ciphertext:Uint8Array;nonce:Uint8Array;tag:Uint8Array;keyVersion:string},
    applicationId:string):string {
    if (sealed.keyVersion!==this.version) throw new Error('Unsupported Driver application key version');
    const decipher=createDecipheriv('aes-256-gcm',this.key,sealed.nonce);
    decipher.setAAD(Buffer.from(`cab:driver:application:v1\0${applicationId}`));
    decipher.setAuthTag(Buffer.from(sealed.tag));
    return Buffer.concat([decipher.update(sealed.ciphertext),decipher.final()]).toString('utf8');
  }
}
