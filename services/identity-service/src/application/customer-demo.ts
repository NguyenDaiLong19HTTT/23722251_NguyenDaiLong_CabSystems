import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createClient, facadeError, markWorkerHealthy, readTlsFromEnvironment, serviceDefinition, unaryCall } from '@cab/grpc-transport';
import {canonicalPhone,isDomesticPhone,publicPhone} from '@cab/phone-number';
import { IdentityCrypto } from '../infrastructure/crypto.js';
import type { PrismaClient } from '../infrastructure/prisma/generated/client.js';
import { persistConfirmedCompensation } from '../infrastructure/prisma/registration-persistence.js';

type Dict = Record<string,unknown>;
type AccountRow = {account_id:string;full_name:string;role:string;account_status:string;
  registration_access_state:string;password_hash:string;confirmed_profile_id:string|null;
  email_ciphertext:Uint8Array;email_nonce:Uint8Array;email_tag:Uint8Array;email_key_version:string;
  phone_ciphertext:Uint8Array;phone_nonce:Uint8Array;phone_tag:Uint8Array;phone_key_version:string;
  created_at:Date;updated_at:Date;version:bigint};
type OperationRow = {operation_id:string;account_id:string;target_profile_id:string;
  public_status:string;internal_phase:string;created_at:Date;updated_at:Date;terminal_at:Date|null;
  public_lookup_until:Date|null;terminal_error_code:string|null;version:bigint;
  recovery_token_digest:Uint8Array;request_fingerprint_hmac:Uint8Array;
  result_snapshot_ciphertext:Uint8Array|null;result_snapshot_nonce:Uint8Array|null;
  result_snapshot_tag:Uint8Array|null;result_snapshot_key_version:string|null};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const timestamp = (date:Date) => ({seconds:String(Math.floor(date.getTime()/1000)),nanos:(date.getTime()%1000)*1e6});
function failure(code:grpc.status,reason:string):grpc.ServiceError {
  const origin=['INVALID_CREDENTIALS','UNAUTHENTICATED','REGISTRATION_RECOVERY_INVALID',
    'REGISTRATION_NOT_FOUND'].includes(reason) ? 'END_USER' : undefined;
  return facadeError(code,reason,origin);
}
function normalize(value:string):string { return value.trim().toLowerCase(); }
function isRecord(value:unknown):value is Dict { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function uniqueViolation(error:unknown):boolean {
  if (!isRecord(error)) return false;
  const meta=isRecord(error.meta)?error.meta:{};
  return ['P2002','23505'].includes(String(error.code)) ||
    error.code==='P2010' && String(meta.code)==='23505';
}

export class IdentityCustomerDemo {
  private readonly customer:grpc.Client;
  private readonly trip:grpc.Client;
  private readonly definition = serviceDefinition('cab.internal.v1.CustomerInternalService',
    'proto/cab/internal/v1/customer.proto');
  private readonly tripDefinition=serviceDefinition('cab.internal.v1.TripInternalService',
    'proto/cab/internal/v1/trip.proto');
  private recovery?:NodeJS.Timeout;
  constructor(private readonly db:PrismaClient,private readonly crypto:IdentityCrypto) {
    const address = process.env.CUSTOMER_SERVICE_GRPC_TARGET;
    if (!address) throw new Error('Customer gRPC target is missing');
    this.customer = createClient(address,readTlsFromEnvironment('IDENTITY_SERVICE'),'customer-service');
    const trip=process.env.TRIP_SERVICE_GRPC_TARGET;
    if(!trip) throw new Error('Trip gRPC target is missing');
    this.trip=createClient(trip,readTlsFromEnvironment('IDENTITY_SERVICE'),'trip-service');
  }
  close():void { if (this.recovery) clearInterval(this.recovery);
    this.customer.close();this.trip.close(); }
  startRecovery():void {
    this.recovery = setInterval(() => { void this.recover().then(()=>
      markWorkerHealthy('identity','customer-recovery')).catch(() => undefined); },1000);
    this.recovery.unref();
    void this.recover().then(()=>markWorkerHealthy('identity','customer-recovery'))
      .catch(() => undefined);
  }
  private async customerCall<T extends object>(method:string,request:object,timeout:number):Promise<T> {
    const metadata = new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
    return unaryCall<object,T>(this.customer,this.definition,method,request,metadata,timeout);
  }
  private async operation(id:string):Promise<OperationRow|null> {
    const rows = await this.db.$queryRaw<OperationRow[]>`SELECT * FROM registration_operation WHERE operation_id=${id}`;
    return rows[0] ?? null;
  }
  private async account(id:string):Promise<AccountRow|null> {
    const rows = await this.db.$queryRaw<AccountRow[]>`SELECT * FROM account WHERE account_id=${id}::uuid`;
    return rows[0] ?? null;
  }
  private accountDto(row:AccountRow):Dict {
    const read = (kind:'email'|'phone') => this.crypto.open('contact',{
      ciphertext:row[`${kind}_ciphertext`],nonce:row[`${kind}_nonce`],tag:row[`${kind}_tag`],
      keyVersion:row[`${kind}_key_version`]},`${row.account_id}:${kind}`);
    const profile = row.role === 'CUSTOMER' ? 'customer_id' : row.role === 'DRIVER' ? 'driver_id' : 'operator_id';
    return {account_id:row.account_id,full_name:row.full_name,email:read('email'),phone:publicPhone(read('phone')),
      role:row.role,account_status:row.account_status,[profile]:row.confirmed_profile_id,
      created_at:timestamp(row.created_at),updated_at:timestamp(row.updated_at)};
  }
  private async operationDto(row:OperationRow):Promise<Dict> {
    const base:Dict = {operation_id:row.operation_id,status:row.public_status,
      created_at:timestamp(row.created_at),updated_at:timestamp(row.updated_at)};
    if (row.public_status === 'SUCCEEDED') {
      if (!row.result_snapshot_ciphertext || !row.result_snapshot_nonce || !row.result_snapshot_tag ||
          !row.result_snapshot_key_version) throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
      base.result = JSON.parse(this.crypto.open('snapshot',{
        ciphertext:row.result_snapshot_ciphertext,nonce:row.result_snapshot_nonce,
        tag:row.result_snapshot_tag,keyVersion:row.result_snapshot_key_version},row.operation_id));
      if (!isRecord(base.result) || typeof base.result.phone !== 'string')
        throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
      base.result.phone = publicPhone(base.result.phone);
    }
    if (row.public_status === 'FAILED') base.error = {error_code:row.terminal_error_code ?? 'SERVICE_UNAVAILABLE',
      message:'Registration could not be completed'};
    return base;
  }
  private async replay(row:OperationRow,recovery:string,canonical:string):Promise<Dict> {
    if (!this.crypto.matches('recovery',recovery,row.recovery_token_digest))
      throw failure(grpc.status.UNAUTHENTICATED,'REGISTRATION_RECOVERY_INVALID');
    if (!this.crypto.matches('fingerprint',canonical,row.request_fingerprint_hmac))
      throw failure(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
    if (row.public_lookup_until && row.public_lookup_until.getTime() < Date.now())
      throw failure(grpc.status.FAILED_PRECONDITION,'IDEMPOTENCY_KEY_EXPIRED');
    if (row.public_status === 'FAILED') throw failure(grpc.status.FAILED_PRECONDITION,'REGISTRATION_FAILED');
    if (row.public_status === 'SUCCEEDED') return {created:(await this.operationDto(row)).result};
    void this.drive(row.operation_id).catch(() => undefined);
    return {processing:{operation:await this.operationDto(row),retry_after_seconds:1}};
  }
  async register(request:unknown,metadata:grpc.Metadata):Promise<Dict> {
    if (!isRecord(request) || Object.keys(request).some(key=>
        !['full_name','email','phone','password'].includes(key) &&
        !['_full_name','_email','_phone','_password'].includes(key)) ||
        !['full_name','email','phone','password'].every(key=>typeof request[key] === 'string'))
      throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const fullName = (request.full_name as string).trim();
    const contactEmail = normalize(request.email as string), contactPhoneInput = request.phone as string;
    const password = request.password as string;
    if (!fullName || !email.test(contactEmail) || !isDomesticPhone(contactPhoneInput) ||
        password.length < 8 || !/\S/.test(password)) throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const contactPhone=canonicalPhone(contactPhoneInput);
    const key = metadata.get('x-cab-registration-idempotency-key')[0];
    const recovery = metadata.get('x-cab-registration-recovery-token')[0];
    if (typeof key !== 'string' || !uuid.test(key) || typeof recovery !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(recovery)) throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const keyDigest = this.crypto.digest('idempotency',key.toLowerCase());
    const tokenDigest = this.crypto.digest('recovery',recovery);
    const canonical = JSON.stringify([fullName,contactEmail,contactPhone,password]);
    const fingerprint = this.crypto.digest('fingerprint',canonical);
    const existing = await this.db.$queryRaw<OperationRow[]>`
      SELECT * FROM registration_operation WHERE flow_type='CUSTOMER' AND idempotency_key_hmac=${keyDigest}`;
    if (existing[0]) return this.replay(existing[0],recovery,canonical);
    const operationId = randomUUID(),accountId = randomUUID(),customerId = randomUUID(),commandId = randomUUID();
    const encryptedEmail = this.crypto.seal('contact',contactEmail,`${accountId}:email`);
    const encryptedPhone = this.crypto.seal('contact',contactPhone,`${accountId}:phone`);
    const passwordHash = await this.crypto.hashPassword(password);
    const emailDigest = this.crypto.digest('lookup',`EMAIL:${contactEmail}`);
    const phoneDigest = this.crypto.digest('lookup',`PHONE:${contactPhone}`);
    try {
      await this.db.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO account(account_id,full_name,email_ciphertext,email_nonce,email_tag,
          email_key_version,phone_ciphertext,phone_nonce,phone_tag,phone_key_version,
          email_lookup_hmac,phone_lookup_hmac,lookup_key_version,password_hash,role,account_status)
          VALUES (${accountId}::uuid,${fullName},${encryptedEmail.ciphertext},${encryptedEmail.nonce},
            ${encryptedEmail.tag},${encryptedEmail.keyVersion},${encryptedPhone.ciphertext},
            ${encryptedPhone.nonce},${encryptedPhone.tag},${encryptedPhone.keyVersion},
            ${emailDigest},${phoneDigest},${this.crypto.version},${passwordHash},'CUSTOMER','ACTIVE')`;
        await tx.$executeRaw`INSERT INTO registration_operation(operation_id,flow_type,account_id,
          target_profile_id,public_status,internal_phase,idempotency_key_hmac,idempotency_key_version,
          recovery_token_digest,recovery_digest_key_version,request_fingerprint_hmac,fingerprint_key_version)
          VALUES (${operationId},'CUSTOMER',${accountId}::uuid,${customerId}::uuid,'PROCESSING',
            'PROVISION_PENDING',${keyDigest},${this.crypto.version},${tokenDigest},${this.crypto.version},
            ${fingerprint},${this.crypto.version})`;
        for (const [kind,digest] of [['EMAIL',emailDigest],['PHONE',phoneDigest]] as const)
          await tx.$executeRaw`INSERT INTO contact_claim(claim_id,account_id,operation_id,kind,
            lookup_hmac,lookup_key_version) VALUES (${randomUUID()}::uuid,${accountId}::uuid,
              ${operationId},${kind},${digest},${this.crypto.version})`;
        await tx.$executeRaw`INSERT INTO registration_step(step_id,operation_id,step_kind,
          command_id,target_service,request_fingerprint_hmac,step_state)
          VALUES (${randomUUID()}::uuid,${operationId},'PROVISION_CUSTOMER',${commandId}::uuid,
            'customer-service',${this.crypto.digest('fingerprint',JSON.stringify([operationId,accountId,customerId]))},'READY')`;
      });
    } catch (error) {
      if (uniqueViolation(error) || isRecord(error) && error.code==='P2010') {
        const concurrent = await this.db.$queryRaw<OperationRow[]>`
          SELECT * FROM registration_operation WHERE flow_type='CUSTOMER' AND idempotency_key_hmac=${keyDigest}`;
        if (concurrent[0]) return this.replay(concurrent[0],recovery,canonical);
        const occupied = await this.db.$queryRaw<{n:bigint}[]>`
          SELECT count(*) AS n FROM contact_claim WHERE released_at IS NULL AND
            ((kind='EMAIL' AND lookup_hmac=${emailDigest}) OR
             (kind='PHONE' AND lookup_hmac=${phoneDigest}))`;
        if (occupied[0]?.n) throw failure(grpc.status.ALREADY_EXISTS,'CONTACT_CONFLICT');
        const otherRole=await this.db.$queryRaw<{n:bigint}[]>`
          SELECT count(*) AS n FROM account WHERE role<>'CUSTOMER'
            AND registration_access_state<>'FAILED'
            AND (email_lookup_hmac=${emailDigest} OR phone_lookup_hmac=${phoneDigest})`;
        if (otherRole[0]?.n) throw failure(grpc.status.ALREADY_EXISTS,'CONTACT_CONFLICT');
      }
      throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    }
    await this.drive(operationId).catch(() => undefined);
    const row = await this.operation(operationId);
    if (!row) throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    if (row.public_status === 'SUCCEEDED') return {created:(await this.operationDto(row)).result};
    return {processing:{operation:await this.operationDto(row),retry_after_seconds:1}};
  }
  async lookup(request:unknown,metadata:grpc.Metadata):Promise<Dict> {
    const id = isRecord(request) ? request.operation_id : undefined;
    const token = metadata.get('x-cab-registration-recovery-token')[0];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw failure(grpc.status.UNAUTHENTICATED,'REGISTRATION_RECOVERY_INVALID');
    if (typeof id !== 'string' || id.length < 1 || id.length > 128)
      throw failure(grpc.status.NOT_FOUND,'REGISTRATION_NOT_FOUND');
    const row = await this.operation(id);
    if (!row || row.public_lookup_until && row.public_lookup_until.getTime() < Date.now() ||
        !this.crypto.matches('recovery',token,row.recovery_token_digest))
      throw failure(grpc.status.NOT_FOUND,'REGISTRATION_NOT_FOUND');
    return this.operationDto(row);
  }
  private async drive(id:string):Promise<void> {
    const row = await this.operation(id);
    if (!row || row.public_status !== 'PROCESSING' ||
        !['PROVISION_PENDING','PROVISION_UNKNOWN','FINALIZING','COMPENSATING'].includes(row.internal_phase)) return;
    if (row.internal_phase==='COMPENSATING') {await this.compensate(row);return;}
    let outcome:Dict|undefined;
    try { outcome = await this.customerCall<Dict>('GetCustomerProvision',{id},1000); }
    catch (error) {
      if ((error as grpc.ServiceError).code !== grpc.status.NOT_FOUND) return;
    }
    if (!outcome) {
      const steps = await this.db.$queryRaw<{command_id:string}[]>`
        SELECT command_id FROM registration_step WHERE operation_id=${id} AND step_kind='PROVISION_CUSTOMER'`;
      if (!steps[0]) return;
      try { outcome = await this.customerCall<Dict>('ProvisionCustomer',{
        command:{command_id:steps[0].command_id,operation_id:id},
        account_id:row.account_id,customer_id:row.target_profile_id},2000); }
      catch (error) {
        if ((error as grpc.ServiceError).code===grpc.status.ALREADY_EXISTS ||
            (error as grpc.ServiceError).code===grpc.status.FAILED_PRECONDITION) {
          // Another dispatcher may have committed the same operation while this
          // request was in flight. A conflict alone is not rollback evidence.
          try {
            const committed=await this.customerCall<Dict>('GetCustomerProvision',{id},1000);
            if (committed.state==='PROVISIONED' && committed.operation_id===id &&
                committed.account_id===row.account_id && committed.customer_id===row.target_profile_id) {
              await this.finalize(row);
              return;
            }
          } catch { /* Resolve with the durable coordinator phase below. */ }
          await this.startCompensation(row);
          return;
        }
        await this.db.$executeRaw`UPDATE registration_step SET step_state='OUTCOME_UNKNOWN',
          attempt_count=attempt_count+1,next_attempt_at=now()+interval '1 second',updated_at=now()
          WHERE operation_id=${id} AND step_kind='PROVISION_CUSTOMER' AND step_state<>'CONFIRMED'`;
        return;
      }
    }
    if (outcome.state==='PROVISION_CANCELLED' && outcome.operation_id===id &&
        outcome.account_id===row.account_id && outcome.customer_id===row.target_profile_id) {
      await this.startCompensation(row);
      return;
    }
    if (outcome.state !== 'PROVISIONED' || outcome.operation_id !== id ||
        outcome.account_id !== row.account_id || outcome.customer_id !== row.target_profile_id) return;
    await this.finalize(row);
  }
  private async startCompensation(row:OperationRow):Promise<void> {
    try {
      await this.db.$transaction(async tx => {
        const changed=await tx.$executeRaw`UPDATE registration_operation SET internal_phase='COMPENSATING',
          updated_at=now(),version=version+1 WHERE operation_id=${row.operation_id}
          AND version=${row.version} AND public_status='PROCESSING'
          AND internal_phase IN ('PROVISION_PENDING','PROVISION_UNKNOWN','FINALIZING')`;
        if (changed!==1) throw new Error('Compensation CAS lost');
        await tx.$executeRaw`INSERT INTO registration_step(step_id,operation_id,step_kind,
          command_id,target_service,request_fingerprint_hmac,step_state)
          VALUES (${randomUUID()}::uuid,${row.operation_id},'CANCEL_CUSTOMER_PROVISION',
            ${randomUUID()}::uuid,'customer-service',
            ${this.crypto.digest('fingerprint',JSON.stringify([
              'cancel',row.operation_id,row.account_id,row.target_profile_id]))},'READY')`;
      });
    } catch { /* A competing CAS winner owns the durable next step. */ }
    const current=await this.operation(row.operation_id);
    if (current?.internal_phase==='COMPENSATING') await this.compensate(current);
  }
  private async compensate(row:OperationRow):Promise<void> {
    const steps=await this.db.$queryRaw<{command_id:string}[]>`
      SELECT command_id FROM registration_step WHERE operation_id=${row.operation_id}
        AND step_kind='CANCEL_CUSTOMER_PROVISION'`;
    if (!steps[0]) return;
    let outcome:Dict|undefined;
    try {outcome=await this.customerCall<Dict>('GetCustomerProvision',{id:row.operation_id},1000);}
    catch (error) {if ((error as grpc.ServiceError).code!==grpc.status.NOT_FOUND) return;}
    if (!outcome || outcome.state==='PROVISIONED') {
      try {outcome=await this.customerCall<Dict>('CancelCustomerProvision',{
        command:{command_id:steps[0].command_id,operation_id:row.operation_id},
        account_id:row.account_id,profile_id:row.target_profile_id},2000);}
      catch {
        await this.db.$executeRaw`UPDATE registration_step SET step_state='OUTCOME_UNKNOWN',
          attempt_count=attempt_count+1,next_attempt_at=now()+interval '1 second',updated_at=now()
          WHERE operation_id=${row.operation_id} AND step_kind='CANCEL_CUSTOMER_PROVISION'
          AND step_state<>'CONFIRMED'`;
        return;
      }
    }
    if (outcome.state!=='PROVISION_CANCELLED' || outcome.operation_id!==row.operation_id ||
        outcome.account_id!==row.account_id || outcome.customer_id!==row.target_profile_id) return;
    try {
      await persistConfirmedCompensation(this.db,{
        operationId:row.operation_id,accountId:row.account_id,customerId:row.target_profile_id,
        expectedVersion:row.version,cancelCommandId:steps[0].command_id,
        safeErrorCode:'REGISTRATION_FAILED',confirmedCancellation:{
          operationId:row.operation_id,accountId:row.account_id,customerId:row.target_profile_id,
          state:'PROVISION_CANCELLED'},
      });
    } catch {
      // Post-commit replay can conflict; a later scan reads the durable phase.
      await this.operation(row.operation_id);
    }
  }
  private async finalize(row:OperationRow):Promise<void> {
    try {
      await this.db.$transaction(async tx => {
        const updated = await tx.$queryRaw<AccountRow[]>`UPDATE account SET registration_access_state='READY',
          confirmed_profile_id=${row.target_profile_id}::uuid,profile_confirmed_at=now(),
          updated_at=now(),version=version+1 WHERE account_id=${row.account_id}::uuid
          AND registration_access_state='BLOCKED' RETURNING *`;
        if (updated.length !== 1) throw new Error('Registration Account CAS lost');
        const snapshot = this.crypto.seal('snapshot',JSON.stringify(this.accountDto(updated[0]!)),
          row.operation_id);
        const count = await tx.$executeRaw`UPDATE registration_operation SET public_status='SUCCEEDED',
          internal_phase='SUCCEEDED',customer_provision_state='PROVISIONED',
          result_snapshot_ciphertext=${snapshot.ciphertext},result_snapshot_nonce=${snapshot.nonce},
          result_snapshot_tag=${snapshot.tag},result_snapshot_key_version=${snapshot.keyVersion},
          result_snapshot_format_version=1,terminal_at=now(),public_lookup_until=now()+interval '168 hours',
          updated_at=now(),version=version+1 WHERE operation_id=${row.operation_id}
          AND version=${row.version} AND public_status='PROCESSING'
          AND internal_phase IN ('PROVISION_PENDING','PROVISION_UNKNOWN','FINALIZING')`;
        if (count !== 1) throw new Error('Registration CAS lost');
        await tx.$executeRaw`UPDATE registration_step SET step_state='CONFIRMED',updated_at=now()
          WHERE operation_id=${row.operation_id} AND step_kind='PROVISION_CUSTOMER'`;
        await tx.$executeRaw`INSERT INTO identity_outbox(event_id,aggregate_id,aggregate_version,
          event_type,schema_version,payload,publish_state)
          VALUES (${randomUUID()}::uuid,${row.account_id}::uuid,2,'ACCOUNT_PROVISIONED',1,
            ${JSON.stringify({accountId:row.account_id,customerId:row.target_profile_id})}::jsonb,'PENDING')`;
      });
    } catch { /* Another worker may have won the CAS; durable state is authoritative. */ }
  }
  async recover():Promise<void> {
    const rows = await this.db.$queryRaw<{operation_id:string}[]>`
      SELECT operation_id FROM registration_operation WHERE public_status='PROCESSING'
        AND internal_phase IN ('PROVISION_PENDING','PROVISION_UNKNOWN','FINALIZING','COMPENSATING')
      ORDER BY updated_at LIMIT 20`;
    for (const row of rows) await this.drive(row.operation_id).catch(() => undefined);
  }
  async login(request:unknown):Promise<Dict> {
    if (!isRecord(request) || typeof request.email_or_phone !== 'string' ||
        typeof request.password !== 'string' || !request.password)
      throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const input=request.email_or_phone;
    if (input.startsWith('0') && !isDomesticPhone(input) || input.startsWith('+'))
      throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const kind = isDomesticPhone(input) ? 'PHONE' : 'EMAIL';
    const identifier = kind==='PHONE' ? canonicalPhone(input) : normalize(input);
    if (kind==='EMAIL'&&!email.test(identifier))
      throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const digest = this.crypto.digest('lookup',`${kind}:${identifier}`);
    const owners = await this.db.$queryRaw<{account_id:string}[]>`
      SELECT account_id FROM contact_claim WHERE kind=${kind} AND lookup_hmac=${digest}
        AND released_at IS NULL LIMIT 1`;
    let account = owners[0] ? await this.account(owners[0].account_id) : null;
    if (!account) {
      // Other roles are provisioned by their own future flows, not this Customer
      // registration. Never pick an arbitrary historical Customer digest.
      const legacy = kind === 'EMAIL' ? await this.db.$queryRaw<{account_id:string}[]>`
        SELECT account_id FROM account WHERE role<>'CUSTOMER' AND email_lookup_hmac=${digest} LIMIT 2` :
        await this.db.$queryRaw<{account_id:string}[]>`
          SELECT account_id FROM account WHERE role<>'CUSTOMER' AND phone_lookup_hmac=${digest} LIMIT 2`;
      if (legacy.length > 1) throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
      account = legacy[0] ? await this.account(legacy[0].account_id) : null;
    }
    if (!account || !await this.crypto.verifyPassword(account.password_hash,request.password))
      throw failure(grpc.status.UNAUTHENTICATED,'INVALID_CREDENTIALS');
    if (account.account_status !== 'ACTIVE') throw failure(grpc.status.PERMISSION_DENIED,'ACCOUNT_NOT_ACTIVE');
    if (account.registration_access_state !== 'READY' || !account.confirmed_profile_id)
      throw failure(grpc.status.FAILED_PRECONDITION,'REGISTRATION_IN_PROGRESS');
    const sessionId = randomUUID(),refresh = this.crypto.token(),created = new Date();
    const expires = new Date(created.getTime()+7*24*60*60*1000);
    await this.db.$executeRaw`INSERT INTO session(session_id,account_id,refresh_token_digest,
      digest_key_version,created_at,expires_at)
      VALUES (${sessionId}::uuid,${account.account_id}::uuid,${this.crypto.digest('refresh',refresh)},
        ${this.crypto.version},${created},${expires})`;
    const access = await this.crypto.signAccess(account.account_id,sessionId,
      new Date(Math.min(Date.now()+900000,expires.getTime())));
    return {access_token:access,refresh_token:refresh,token_type:'BEARER',expires_in:900,
      session_expires_at:timestamp(expires),account:this.accountDto(account)};
  }
  async verify(metadata:grpc.Metadata):Promise<{account:AccountRow;sessionId:string}> {
    const bearer = metadata.get('x-cab-user-authorization')[0];
    if (typeof bearer !== 'string' || !/^Bearer [^\s]+$/.test(bearer))
      throw failure(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED');
    let claims:{accountId:string;sessionId:string};
    try { claims = await this.crypto.verifyAccess(bearer.slice(7)); }
    catch { throw failure(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED'); }
    const sessions = await this.db.$queryRaw<{account_id:string}[]>`
      SELECT account_id FROM session WHERE session_id=${claims.sessionId}::uuid
        AND account_id=${claims.accountId}::uuid AND revoked_at IS NULL AND expires_at>now()`;
    if (!sessions[0]) throw failure(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED');
    const account = await this.account(claims.accountId);
    if (!account) throw failure(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED');
    if (account.account_status !== 'ACTIVE') throw failure(grpc.status.PERMISSION_DENIED,'ACCOUNT_NOT_ACTIVE');
    if (account.registration_access_state !== 'READY' || !account.confirmed_profile_id)
      throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    return {account,sessionId:claims.sessionId};
  }
  async me(metadata:grpc.Metadata):Promise<Dict> { return this.accountDto((await this.verify(metadata)).account); }
  async verifyInternal(request:unknown,metadata:grpc.Metadata):Promise<Dict> {
    const {account,sessionId} = await this.verify(metadata);
    const roles = isRecord(request) ? request.allowed_roles : undefined;
    if (!Array.isArray(roles) || roles.length === 0 || !roles.includes(account.role))
      throw failure(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    return {account_id:account.account_id,role:account.role,
      ...(account.role==='CUSTOMER' ? {customer_id:account.confirmed_profile_id} : {}),
      ...(account.role==='DRIVER' ? {driver_id:account.confirmed_profile_id} : {}),
      session_id:sessionId,verified_at:timestamp(new Date()),account_version:String(account.version)};
  }
  async eligibility(request:unknown):Promise<Dict> {
    const id=isRecord(request)?request.account_id:undefined;
    const role=isRecord(request)?request.expected_role:undefined;
    if (typeof id!=='string'||!uuid.test(id)||!['CUSTOMER','DRIVER'].includes(String(role)))
      throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const account=await this.account(id);
    if (!account||account.role!==role||account.account_status!=='ACTIVE'||
        account.registration_access_state!=='READY'||!account.confirmed_profile_id)
      throw failure(grpc.status.FAILED_PRECONDITION,'ACCOUNT_NOT_ELIGIBLE');
    return {account_id:id,role,account_version:String(account.version),
      verified_at:timestamp(new Date())};
  }
  async contact(request:unknown,metadata:grpc.Metadata):Promise<Dict> {
    const principal = await this.verify(metadata);
    const id = isRecord(request) ? request.account_id : undefined;
    if (typeof id !== 'string' || !uuid.test(id)) throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const purpose = isRecord(request) ? request.purpose : undefined;
    let closed=false;
    if(purpose==='DRIVER_PUBLIC_PROFILE') {
      if(principal.account.role==='CUSTOMER') {
        const token=metadata.get('x-cab-user-authorization')[0];
        if(typeof token!=='string') throw failure(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED');
        const contextMetadata=new grpc.Metadata();contextMetadata.set('x-correlation-id',randomUUID());
        contextMetadata.set('x-cab-user-authorization',token);
        let relation:Dict;
        try {relation=await unaryCall<Dict,Dict>(this.trip,this.tripDefinition,
          'HasCustomerDriverTrip',{driver_account_id:id},contextMetadata,900);}
        catch {throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');}
        if(relation.related!==true) throw failure(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
      } else if(principal.account.role==='DRIVER'&&principal.account.account_id!==id)
        throw failure(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
      else if(!['DRIVER','OPERATOR'].includes(principal.account.role))
        throw failure(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    } else if(purpose==='ACTIVE_TRIP_CONTACT') {
      const tripId=isRecord(request)?request.trip_id:undefined;
      if(typeof tripId!=='string'||!uuid.test(tripId))
        throw failure(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
      const token=metadata.get('x-cab-user-authorization')[0];
      if(typeof token!=='string') throw failure(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED');
      const contextMetadata=new grpc.Metadata();contextMetadata.set('x-correlation-id',randomUUID());
      contextMetadata.set('x-cab-user-authorization',token);
      let context:Dict;
      try {context=await unaryCall<Dict,Dict>(this.trip,this.tripDefinition,
        'GetActiveTripContactContext',{trip_id:tripId},contextMetadata,900);}
      catch(error) {
        const code=(error as grpc.ServiceError).code;
        if(code===grpc.status.NOT_FOUND) throw failure(grpc.status.NOT_FOUND,'TRIP_NOT_FOUND');
        if(code===grpc.status.PERMISSION_DENIED) throw failure(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
        if(code===grpc.status.UNAUTHENTICATED)
          throw failure(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED');
        throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
      }
      const parties=isRecord(context.parties)?context.parties:{};
      if(context.trip_id!==tripId||
          ![parties.customer_account_id,parties.driver_account_id].includes(id)||
          principal.account.role==='CUSTOMER'&&
            (parties.customer_account_id!==principal.account.account_id||
              parties.customer_id!==principal.account.confirmed_profile_id)||
          principal.account.role==='DRIVER'&&
            (parties.driver_account_id!==principal.account.account_id||
              parties.driver_id!==principal.account.confirmed_profile_id))
        throw failure(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      closed=context.closed===true;
    } else if (principal.account.role === 'OPERATOR' ? purpose !== 'OPERATIONS_PROFILE' :
        (purpose !== 'OWN_PROFILE' || principal.account.account_id !== id))
      throw failure(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
    const account = await this.account(id);
    if (!account) throw failure(grpc.status.NOT_FOUND,'CUSTOMER_NOT_FOUND');
    if (account.registration_access_state!=='READY'||!account.confirmed_profile_id)
      throw failure(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE');
    if(purpose==='DRIVER_PUBLIC_PROFILE') {
      if(account.role!=='DRIVER') throw failure(grpc.status.NOT_FOUND,'DRIVER_NOT_FOUND');
      return {account_id:id,full_name:account.full_name,
        account_version:String(account.version),verified_at:timestamp(new Date()),
        account_status:account.account_status,created_at:timestamp(account.created_at),
        updated_at:timestamp(account.updated_at)};
    }
    const dto = this.accountDto(account);
    return {account_id:id,full_name:dto.full_name,email:dto.email,
      ...(!closed?{phone:dto.phone}:{}),
      account_version:String(account.version),verified_at:timestamp(new Date()),
      account_status:account.account_status,created_at:timestamp(account.created_at),
      updated_at:timestamp(account.updated_at)};
  }
}
