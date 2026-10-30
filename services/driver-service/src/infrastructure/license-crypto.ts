import { createCipheriv,createDecipheriv,createHmac,randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Driver-owned key; never reuses Identity contact, token or fingerprint keys.
export class DriverLicenseCrypto {
  private readonly key:Buffer;
  readonly version='local-v1';
  constructor() {
    const path=process.env.CAB_DRIVER_LICENSE_KEY_FILE;
    if (!path) throw new Error('Driver license key configuration is missing');
    try {this.key=Buffer.from(readFileSync(path,'utf8').trim(),'base64url');}
    catch {throw new Error('Driver license key configuration is invalid');}
    if (this.key.length!==32) throw new Error('Driver license key configuration is invalid');
  }
  digest(value:string):Buffer {
    return createHmac('sha256',this.key).update('cab:driver:license-lookup:v1\0')
      .update(value.toUpperCase(),'utf8').digest();
  }
  seal(value:string,driverId:string) {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    cipher.setAAD(Buffer.from(`cab:driver:license:v1\0${driverId}`));
    return {ciphertext:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]),
      nonce,tag:cipher.getAuthTag(),keyVersion:this.version};
  }
  open(sealed:{ciphertext:Uint8Array;nonce:Uint8Array;tag:Uint8Array;keyVersion:string},
    driverId:string):string {
    if (sealed.keyVersion!==this.version) throw new Error('Unsupported Driver key version');
    const cipher=createDecipheriv('aes-256-gcm',this.key,sealed.nonce);
    cipher.setAAD(Buffer.from(`cab:driver:license:v1\0${driverId}`));
    cipher.setAuthTag(Buffer.from(sealed.tag));
    return Buffer.concat([cipher.update(sealed.ciphertext),cipher.final()]).toString('utf8');
  }
}
