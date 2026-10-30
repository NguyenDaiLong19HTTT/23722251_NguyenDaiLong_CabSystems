import { randomInt,randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createClient,decodeFacadeError,facadeError,markWorkerHealthy,readTlsFromEnvironment,serviceDefinition,unaryCall } from '@cab/grpc-transport';
import {canonicalPhone,isDomesticPhone,publicPhone} from '@cab/phone-number';
import { IdentityCrypto } from '../infrastructure/crypto.js';
import type { PrismaClient } from '../infrastructure/prisma/generated/client.js';

type Data=Record<string,unknown>;
type Challenge={challenge_id:string;phone_lookup_hmac:Uint8Array;
  phone_ciphertext:Uint8Array;phone_nonce:Uint8Array;phone_tag:Uint8Array;phone_key_version:string;
  code_digest:Uint8Array;failed_attempts:number;created_at:Date;expires_at:Date;
  resend_available_at:Date;verified_at:Date|null;invalidated_at:Date|null};
type Verification={verification_id:string;challenge_id:string;phone_lookup_hmac:Uint8Array;
  token_digest:Uint8Array;verified_at:Date;expires_at:Date;consumed_operation_id:string|null};
type Operation={operation_id:string;account_id:string;driver_id:string;application_id:string;
  command_id:string;verification_id:string;idempotency_key_hmac:Uint8Array;
  request_fingerprint_hmac:Uint8Array;public_status:string;phase:string;
  payload_ciphertext:Uint8Array;payload_nonce:Uint8Array;payload_tag:Uint8Array;
  payload_key_version:string;result_json:Data|null;terminal_error_code:string|null;
  created_at:Date;updated_at:Date;public_lookup_until:Date|null};
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const stamp=(d:Date)=>({seconds:String(Math.floor(d.getTime()/1000)),nanos:(d.getTime()%1000)*1e6});
const fail=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>facadeError(code,reason,origin);
const equals=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));

export class IdentityDriverRegistration {
  private readonly driver:grpc.Client;
  private readonly definition=serviceDefinition('cab.internal.v1.DriverInternalService',
    'proto/cab/internal/v1/driver.proto');
  private recovery?:NodeJS.Timeout;
  constructor(private readonly db:PrismaClient,private readonly crypto:IdentityCrypto) {
    const address=process.env.DRIVER_SERVICE_GRPC_TARGET;
    if (!address) throw new Error('Driver gRPC target is missing');
    this.driver=createClient(address,readTlsFromEnvironment('IDENTITY_SERVICE'),'driver-service');
  }
  close():void {if (this.recovery) clearInterval(this.recovery);this.driver.close();}
  startRecovery():void {
    this.recovery=setInterval(()=>{void this.recover().then(()=>
      markWorkerHealthy('identity','driver-recovery')).catch(()=>undefined);},1000);
    this.recovery.unref();void this.recover().then(()=>
      markWorkerHealthy('identity','driver-recovery')).catch(()=>undefined);
  }
  private async operation(id:string):Promise<Operation|null> {
    const rows=await this.db.$queryRaw<Operation[]>`SELECT * FROM driver_registration
      WHERE operation_id=${id}::uuid`;
    return rows[0]??null;
  }
  async requestOtp(request:unknown):Promise<Data> {
    if (!record(request)||!isDomesticPhone(request.phone))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    if (process.env.CAB_DEV_OTP_ENABLED!=='1') throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    const number=canonicalPhone(request.phone),digest=this.crypto.digest('lookup',`PHONE:${number}`);
    const challengeId=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0');
    const now=new Date(),expires=new Date(now.getTime()+300000),resend=new Date(now.getTime()+60000);
    const sealedPhone=this.crypto.seal('contact',number,`${challengeId}:phone`);
    const sealedCode=this.crypto.seal('otp',code,challengeId);
    const codeDigest=this.crypto.digest('otp',`${challengeId}:${code}`);
    await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${number},0)) IS NULL AS locked`;
      const existing=await tx.$queryRaw<{account_id:string}[]>`SELECT account_id FROM account
        WHERE phone_lookup_hmac=${digest} AND registration_access_state<>'FAILED' LIMIT 1`;
      if (existing[0]) throw fail(grpc.status.ALREADY_EXISTS,'CONTACT_ALREADY_EXISTS');
      const previous=await tx.$queryRaw<{resend_available_at:Date}[]>`
        SELECT resend_available_at FROM driver_otp_challenge WHERE phone_lookup_hmac=${digest}
        ORDER BY created_at DESC LIMIT 1`;
      if (previous[0]&&previous[0].resend_available_at>now)
        throw fail(grpc.status.RESOURCE_EXHAUSTED,'RATE_LIMIT_EXCEEDED','END_USER');
      await tx.$executeRaw`UPDATE driver_otp_challenge SET invalidated_at=${now}
        WHERE phone_lookup_hmac=${digest} AND invalidated_at IS NULL`;
      await tx.$executeRaw`INSERT INTO driver_otp_challenge(challenge_id,phone_lookup_hmac,
        phone_ciphertext,phone_nonce,phone_tag,phone_key_version,purpose,code_digest,
        delivery_ciphertext,delivery_nonce,delivery_tag,delivery_key_version,delivery_state,
        created_at,expires_at,resend_available_at) VALUES (${challengeId}::uuid,${digest},
        ${sealedPhone.ciphertext},${sealedPhone.nonce},${sealedPhone.tag},${sealedPhone.keyVersion},
        'DRIVER_REGISTRATION',${codeDigest},${sealedCode.ciphertext},${sealedCode.nonce},
        ${sealedCode.tag},${sealedCode.keyVersion},'DEV_AVAILABLE',${now},${expires},${resend})`;
    });
    return {challenge_id:challengeId,purpose:'DRIVER_REGISTRATION',status:'ACCEPTED',
      created_at:stamp(now),expires_at:stamp(expires),resend_available_at:stamp(resend),
      ...(process.env.NODE_ENV==='development'&&process.env.CAB_DEMO_OTP_RESPONSE_ENABLED==='1'
        ?{otp:code}:{})};
  }
  async verifyOtp(request:unknown):Promise<Data> {
    if (!record(request)||typeof request.challenge_id!=='string'||!uuid.test(request.challenge_id)||
        typeof request.otp!=='string'||!/^\d{6}$/.test(request.otp))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const id=request.challenge_id,code=request.otp;
    return this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<Challenge[]>`SELECT * FROM driver_otp_challenge
        WHERE challenge_id=${id}::uuid FOR UPDATE`;
      const row=rows[0];
      if (!row||row.invalidated_at||row.expires_at<=new Date()||row.failed_attempts>=5)
        throw fail(grpc.status.INVALID_ARGUMENT,'OTP_INVALID_OR_EXPIRED','END_USER');
      if (row.verified_at) throw fail(grpc.status.ALREADY_EXISTS,'OTP_ALREADY_VERIFIED','END_USER');
      if (!this.crypto.matches('otp',`${id}:${code}`,row.code_digest)) {
        await tx.$executeRaw`UPDATE driver_otp_challenge SET failed_attempts=failed_attempts+1,
          invalidated_at=CASE WHEN failed_attempts+1>=5 THEN now() ELSE NULL END
          WHERE challenge_id=${id}::uuid`;
        return {invalid:true};
      }
      const verified=new Date(),expires=new Date(verified.getTime()+300000),token=this.crypto.token();
      const verificationId=randomUUID();
      await tx.$executeRaw`UPDATE driver_otp_challenge SET verified_at=${verified}
        WHERE challenge_id=${id}::uuid`;
      await tx.$executeRaw`INSERT INTO driver_phone_verification(verification_id,challenge_id,
        phone_lookup_hmac,token_digest,verified_at,expires_at)
        VALUES (${verificationId}::uuid,${id}::uuid,${row.phone_lookup_hmac},
        ${this.crypto.digest('verification',token)},${verified},${expires})`;
      const number=this.crypto.open('contact',{ciphertext:row.phone_ciphertext,
        nonce:row.phone_nonce,tag:row.phone_tag,keyVersion:row.phone_key_version},`${id}:phone`);
      return {verification_token:token,purpose:'DRIVER_REGISTRATION',verified_phone:publicPhone(number),
        verified_at:stamp(verified),expires_at:stamp(expires)};
    }).then(result=>{
      if ('invalid' in result) throw fail(grpc.status.INVALID_ARGUMENT,'OTP_INVALID_OR_EXPIRED','END_USER');
      return result;
    });
  }
  private dto(row:Operation):Data {
    return {operation_id:row.operation_id,status:row.public_status,
      created_at:stamp(row.created_at),updated_at:stamp(row.updated_at),
      ...(row.public_status==='SUCCEEDED'?{result:row.result_json}:{}),
      ...(row.public_status==='FAILED'?{error_code:row.terminal_error_code}:{}),
    };
  }
  private async replay(row:Operation,token:string,fingerprint:Buffer):Promise<Data> {
    if (!this.crypto.matches('verification',token,(await this.db.$queryRaw<Verification[]>`
        SELECT * FROM driver_phone_verification WHERE verification_id=${row.verification_id}::uuid`)[0]!.token_digest)
      ||!equals(row.request_fingerprint_hmac,fingerprint))
      throw fail(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT','END_USER');
    if (row.public_lookup_until&&row.public_lookup_until<new Date())
      throw fail(grpc.status.FAILED_PRECONDITION,'IDEMPOTENCY_KEY_EXPIRED');
    if (row.public_status==='SUCCEEDED') return {created:row.result_json};
    if (row.public_status==='FAILED') throw fail(grpc.status.FAILED_PRECONDITION,'REGISTRATION_FAILED');
    void this.drive(row.operation_id).catch(()=>undefined);
    return {processing:this.dto(row)};
  }
  async submit(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    if (!record(request)||!['verification_token','full_name','email','password','license_number']
      .every(k=>typeof request[k]==='string')||!record(request.vehicle)||
        typeof request.vehicle.plate_number!=='string'||
        request.vehicle.vehicle_type!=='MOTORBIKE')
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const token=request.verification_token as string,fullName=(request.full_name as string).trim();
    const mail=(request.email as string).trim().toLowerCase(),password=request.password as string;
    const license=(request.license_number as string).trim().toUpperCase();
    const plate=(request.vehicle.plate_number as string).trim().toUpperCase();
    const vehicleType=request.vehicle.vehicle_type as string;
    if (token.length<32||!fullName||fullName.length>200||!email.test(mail)||mail.length>254||
        password.length<8||!license||license.length>100||!plate||plate.length>30)
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const key=metadata.get('x-cab-registration-idempotency-key')[0];
    if (typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const keyDigest=this.crypto.digest('idempotency',key.toLowerCase());
    const fingerprint=this.crypto.digest('fingerprint',JSON.stringify([token,fullName,mail,password,
      license,plate,vehicleType]));
    const prior=await this.db.$queryRaw<Operation[]>`
      SELECT * FROM driver_registration WHERE idempotency_key_hmac=${keyDigest}`;
    if (prior[0]) return this.replay(prior[0],token,fingerprint);
    const verificationRows=await this.db.$queryRaw<(Verification&Challenge)[]>`
      SELECT v.*,c.phone_ciphertext,c.phone_nonce,c.phone_tag,c.phone_key_version,c.invalidated_at
      FROM driver_phone_verification v JOIN driver_otp_challenge c ON c.challenge_id=v.challenge_id
      WHERE v.token_digest=${this.crypto.digest('verification',token)}`;
    const proof=verificationRows[0];
    if (!proof||proof.expires_at<=new Date()||proof.invalidated_at)
      throw fail(grpc.status.INVALID_ARGUMENT,'VERIFICATION_TOKEN_INVALID_OR_EXPIRED','END_USER');
    if (proof.consumed_operation_id)
      throw fail(grpc.status.ALREADY_EXISTS,'VERIFICATION_TOKEN_USED','END_USER');
    const number=this.crypto.open('contact',{ciphertext:proof.phone_ciphertext,
      nonce:proof.phone_nonce,tag:proof.phone_tag,keyVersion:proof.phone_key_version},
      `${proof.challenge_id}:phone`);
    const operationId=randomUUID(),accountId=randomUUID(),driverId=randomUUID();
    const applicationId=randomUUID(),commandId=randomUUID();
    const encryptedEmail=this.crypto.seal('contact',mail,`${accountId}:email`);
    const encryptedPhone=this.crypto.seal('contact',number,`${accountId}:phone`);
    const payload=this.crypto.seal('snapshot',JSON.stringify({fullName,mail,number,license,plate,
      vehicleType,phoneVerifiedAt:proof.verified_at.toISOString()}),operationId);
    const hash=await this.crypto.hashPassword(password);
    try {
      await this.db.$transaction(async tx=>{
        const locked=await tx.$queryRaw<Verification[]>`
          SELECT * FROM driver_phone_verification WHERE verification_id=${proof.verification_id}::uuid FOR UPDATE`;
        if (!locked[0]||locked[0].expires_at<=new Date())
          throw fail(grpc.status.INVALID_ARGUMENT,'VERIFICATION_TOKEN_INVALID_OR_EXPIRED','END_USER');
        if (locked[0].consumed_operation_id)
          throw fail(grpc.status.ALREADY_EXISTS,'VERIFICATION_TOKEN_USED','END_USER');
        await tx.$executeRaw`INSERT INTO account(account_id,full_name,email_ciphertext,email_nonce,
          email_tag,email_key_version,phone_ciphertext,phone_nonce,phone_tag,phone_key_version,
          email_lookup_hmac,phone_lookup_hmac,lookup_key_version,password_hash,role,account_status)
          VALUES (${accountId}::uuid,${fullName},${encryptedEmail.ciphertext},${encryptedEmail.nonce},
          ${encryptedEmail.tag},${encryptedEmail.keyVersion},${encryptedPhone.ciphertext},
          ${encryptedPhone.nonce},${encryptedPhone.tag},${encryptedPhone.keyVersion},
          ${this.crypto.digest('lookup',`EMAIL:${mail}`)},${proof.phone_lookup_hmac},
          ${this.crypto.version},${hash},'DRIVER','ACTIVE')`;
        await tx.$executeRaw`INSERT INTO driver_registration(operation_id,account_id,driver_id,
          application_id,command_id,verification_id,idempotency_key_hmac,request_fingerprint_hmac,
          public_status,phase,payload_ciphertext,payload_nonce,payload_tag,payload_key_version)
          VALUES (${operationId}::uuid,${accountId}::uuid,${driverId}::uuid,${applicationId}::uuid,
          ${commandId}::uuid,${proof.verification_id}::uuid,${keyDigest},${fingerprint},
          'PROCESSING','PROVISION_PENDING',${payload.ciphertext},${payload.nonce},${payload.tag},
          ${payload.keyVersion})`;
        await tx.$executeRaw`UPDATE driver_phone_verification SET consumed_operation_id=${operationId}::uuid,
          consumed_at=now() WHERE verification_id=${proof.verification_id}::uuid`;
      });
    } catch(error) {
      if (record(error)&&['P2002','P2010'].includes(String(error.code))) {
        const raced=await this.db.$queryRaw<Operation[]>`
          SELECT * FROM driver_registration WHERE idempotency_key_hmac=${keyDigest}`;
        if (raced[0]) return this.replay(raced[0],token,fingerprint);
        throw fail(grpc.status.ALREADY_EXISTS,'CONTACT_ALREADY_EXISTS');
      }
      throw error;
    }
    await this.drive(operationId).catch(()=>undefined);
    const current=await this.operation(operationId);
    if (!current) throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    if (current.public_status==='SUCCEEDED') return {created:current.result_json};
    if (current.public_status==='FAILED') throw fail(grpc.status.FAILED_PRECONDITION,'REGISTRATION_FAILED');
    return {processing:this.dto(current)};
  }
  async lookup(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const id=record(request)?request.operation_id:undefined;
    const token=metadata.get('x-cab-driver-verification-token')[0];
    const key=metadata.get('x-cab-registration-idempotency-key')[0];
    if (typeof token!=='string')
      throw fail(grpc.status.UNAUTHENTICATED,'REGISTRATION_PROOF_REQUIRED','END_USER');
    if (typeof id!=='string'||!uuid.test(id)||
        (key!==undefined&&(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))))
      throw fail(grpc.status.NOT_FOUND,'REGISTRATION_OPERATION_NOT_FOUND','END_USER');
    const row=await this.operation(id);
    if (!row||(typeof key==='string'&&
        !equals(row.idempotency_key_hmac,this.crypto.digest('idempotency',key.toLowerCase()))))
      throw fail(grpc.status.NOT_FOUND,'REGISTRATION_OPERATION_NOT_FOUND','END_USER');
    const proof=await this.db.$queryRaw<Verification[]>`SELECT * FROM driver_phone_verification
      WHERE verification_id=${row.verification_id}::uuid`;
    if (!proof[0]||!this.crypto.matches('verification',token,proof[0].token_digest)||
        (row.public_lookup_until&&row.public_lookup_until<new Date()))
      throw fail(grpc.status.NOT_FOUND,'REGISTRATION_OPERATION_NOT_FOUND','END_USER');
    return this.dto(row);
  }
  private async drive(id:string):Promise<void> {
    const row=await this.operation(id);
    if (!row||row.public_status!=='PROCESSING') return;
    const payload=JSON.parse(this.crypto.open('snapshot',{ciphertext:row.payload_ciphertext,
      nonce:row.payload_nonce,tag:row.payload_tag,keyVersion:row.payload_key_version},id)) as
      {fullName:string;mail:string;number:string;license:string;plate:string;
        vehicleType:string;phoneVerifiedAt:string};
    const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
    const request={command:{command_id:row.command_id,operation_id:id},account_id:row.account_id,
      driver_id:row.driver_id,application_id:row.application_id,license_number:payload.license,
      proposed_vehicle:{type:payload.vehicleType,plate_number:payload.plate},
      applicant_full_name:payload.fullName,applicant_email:payload.mail,
      applicant_phone:payload.number,phone_verified_at:stamp(new Date(payload.phoneVerifiedAt))};
    let provision:Data|undefined,permanentConflict=false;
    try {provision=await unaryCall<object,Data>(this.driver,this.definition,'ProvisionDriver',request,metadata,2000);}
    catch(error) {
      permanentConflict=decodeFacadeError(error as grpc.ServiceError)?.reason==='LICENSE_ALREADY_EXISTS';
      try {provision=await unaryCall<object,Data>(this.driver,this.definition,'GetDriverProvision',
        {id},metadata,1000);} catch { /* timeout/NOT_FOUND alone never proves rollback */ }
    }
    if (permanentConflict&&!provision) {
      try {
        const cancelled=await unaryCall<object,Data>(this.driver,this.definition,
          'CancelDriverProvision',{command:{command_id:randomUUID(),operation_id:id},
            account_id:row.account_id,driver_id:row.driver_id},metadata,2000);
        if (cancelled.state==='DRIVER_PROVISION_CANCELLED') {
          await this.db.$transaction(async tx=>{
            await tx.$executeRaw`UPDATE account SET registration_access_state='FAILED',
              updated_at=now() WHERE account_id=${row.account_id}::uuid
              AND registration_access_state='BLOCKED'`;
            await tx.$executeRaw`UPDATE driver_registration SET public_status='FAILED',phase='FAILED',
              terminal_error_code='LICENSE_ALREADY_EXISTS',updated_at=now(),terminal_at=now(),
              public_lookup_until=now()+interval '168 hours'
              WHERE operation_id=${id}::uuid AND public_status='PROCESSING'`;
          });
          return;
        }
      } catch { /* keep PROCESSING until outcome can be proven */ }
    }
    if (!provision||provision.state!=='DRIVER_PROVISIONED'||
        provision.account_id!==row.account_id||provision.driver_id!==row.driver_id||
        provision.application_id!==row.application_id) {
      await this.db.$executeRaw`UPDATE driver_registration SET phase='PROVISION_UNKNOWN',updated_at=now()
        WHERE operation_id=${id}::uuid AND public_status='PROCESSING'`;
      return;
    }
    const result={account_id:row.account_id,driver_id:row.driver_id,
      application_id:row.application_id,account_status:'ACTIVE',approval_status:'PENDING_APPROVAL',
      driver_status:'OFFLINE',application_status:'SUBMITTED',submitted_at:provision.submitted_at};
    await this.db.$transaction(async tx=>{
      await tx.$executeRaw`UPDATE account SET registration_access_state='READY',
        confirmed_profile_id=${row.driver_id}::uuid,profile_confirmed_at=now(),updated_at=now()
        WHERE account_id=${row.account_id}::uuid AND registration_access_state='BLOCKED'`;
      await tx.$executeRaw`UPDATE driver_registration SET public_status='SUCCEEDED',phase='SUCCEEDED',
        result_json=${JSON.stringify(result)}::jsonb,updated_at=now(),terminal_at=now(),
        public_lookup_until=now()+interval '168 hours'
        WHERE operation_id=${id}::uuid AND public_status='PROCESSING'`;
    });
  }
  private async recover():Promise<void> {
    const rows=await this.db.$queryRaw<{operation_id:string}[]>`SELECT operation_id
      FROM driver_registration WHERE public_status='PROCESSING' ORDER BY updated_at LIMIT 10`;
    for (const row of rows) await this.drive(row.operation_id).catch(()=>undefined);
  }
}
