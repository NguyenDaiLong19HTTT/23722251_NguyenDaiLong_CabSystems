import {randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {DriverApplicationCrypto} from '../infrastructure/application-crypto.js';
import {DriverLicenseCrypto} from '../infrastructure/license-crypto.js';
import type {PrismaClient} from '../infrastructure/prisma/generated/client.js';

type Data=Record<string,unknown>;
type Provision={operation_id:string;command_id:string;account_id:string;driver_id:string;
  application_id:string;payload_digest:Uint8Array;state:string;committed_at:Date};
type Application={application_id:string;account_id:string;driver_id:string;operation_id:string;
  status:string;snapshot_ciphertext:Uint8Array;snapshot_nonce:Uint8Array;snapshot_tag:Uint8Array;
  snapshot_key_version:string;version:bigint;submitted_at:Date;updated_at:Date;
  reviewed_at:Date|null;reviewed_by_account_id:string|null;rejection_reason:string|null;
  approved_vehicle_id:string|null};
type Driver={driver_id:string;account_id:string;license_ciphertext:Uint8Array;
  license_nonce:Uint8Array;license_tag:Uint8Array;license_key_version:string;
  approval_status:string;rejection_reason:string|null;driver_status:string;version:bigint;
  created_at:Date;updated_at:Date};
type Vehicle={vehicle_id:string;plate_number:string;vehicle_type:string;vehicle_status:string;
  version:bigint;created_at:Date;updated_at:Date};
type Snapshot={fullName:string;email:string;phone:string;phoneVerifiedAt:string;
  licenseNumber:string;plateNumber:string;vehicleType:string};
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stamp=(d:Date)=>({seconds:String(Math.floor(d.getTime()/1000)),nanos:(d.getTime()%1000)*1e6});
const denied=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>facadeError(code,reason,origin);

export class DriverApplications {
  private readonly crypto=new DriverApplicationCrypto();
  private readonly license=new DriverLicenseCrypto();
  private readonly identity:grpc.Client;
  private readonly identityDefinition=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  constructor(private readonly db:PrismaClient) {
    const target=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    if (!target) throw new Error('Identity gRPC target is missing');
    this.identity=createClient(target,readTlsFromEnvironment('DRIVER_SERVICE'),'identity-service');
  }
  close():void {this.identity.close();}
  private provisionDto(row:Provision):Data {
    return {operation_id:row.operation_id,account_id:row.account_id,driver_id:row.driver_id,
      application_id:row.application_id,state:row.state,submitted_at:stamp(row.committed_at)};
  }
  private async provisionRow(id:string):Promise<Provision|null> {
    const rows=await this.db.$queryRaw<Provision[]>`SELECT * FROM driver_provision_receipt
      WHERE operation_id=${id}::uuid`;
    return rows[0]??null;
  }
  async provision(request:unknown):Promise<Data> {
    if (!record(request)||!record(request.command)||
        ![request.command.command_id,request.command.operation_id,request.account_id,
          request.driver_id,request.application_id].every(v=>typeof v==='string'&&uuid.test(v))||
        typeof request.license_number!=='string'||!request.license_number||
        !record(request.proposed_vehicle)||
        request.proposed_vehicle.type!=='MOTORBIKE'||
        typeof request.proposed_vehicle.plate_number!=='string'||
        !record(request.phone_verified_at)||typeof request.applicant_full_name!=='string'||
        typeof request.applicant_email!=='string'||typeof request.applicant_phone!=='string')
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const command=request.command,operationId=command.operation_id as string;
    const accountId=request.account_id as string,driverId=request.driver_id as string;
    const applicationId=request.application_id as string,license=request.license_number as string;
    const plate=(request.proposed_vehicle.plate_number as string).trim();
    const vehicleType=request.proposed_vehicle.type as string;
    const verified=typeof request.phone_verified_at.seconds==='string'
      ?new Date(Number(request.phone_verified_at.seconds)*1000):new Date(NaN);
    if (!plate||!Number.isFinite(verified.getTime()))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const snapshot:Snapshot={fullName:request.applicant_full_name as string,
      email:request.applicant_email as string,phone:request.applicant_phone as string,
      phoneVerifiedAt:verified.toISOString(),licenseNumber:license,plateNumber:plate,vehicleType};
    const canonical=JSON.stringify([accountId,driverId,applicationId,snapshot]);
    const digest=this.crypto.digest('provision',canonical);
    const existing=await this.provisionRow(operationId);
    if (existing) {
      if (existing.command_id!==command.command_id||!this.crypto.matches('provision',canonical,
          existing.payload_digest)) throw denied(grpc.status.ALREADY_EXISTS,'PROVISION_CONFLICT');
      return this.provisionDto(existing);
    }
    const sealedLicense=this.license.seal(license,driverId);
    const sealedSnapshot=this.crypto.seal(JSON.stringify(snapshot),applicationId);
    try {
      await this.db.$transaction(async tx=>{
        const prior=await tx.$queryRaw<Provision[]>`SELECT * FROM driver_provision_receipt
          WHERE operation_id=${operationId}::uuid`;
        if (prior[0]) return;
        const collision=await tx.$queryRaw<{driver_id:string}[]>`
          SELECT driver_id FROM driver_profile WHERE license_lookup_hmac=${this.license.digest(license)} LIMIT 1`;
        if (collision[0]) throw denied(grpc.status.ALREADY_EXISTS,'LICENSE_ALREADY_EXISTS');
        await tx.$executeRaw`INSERT INTO driver_profile(driver_id,account_id,license_ciphertext,
          license_nonce,license_tag,license_key_version,license_lookup_hmac,approval_status,driver_status)
          VALUES (${driverId}::uuid,${accountId}::uuid,${sealedLicense.ciphertext},
          ${sealedLicense.nonce},${sealedLicense.tag},${sealedLicense.keyVersion},
          ${this.license.digest(license)},'PENDING_APPROVAL','OFFLINE')`;
        await tx.$executeRaw`INSERT INTO driver_application(application_id,account_id,driver_id,
          operation_id,status,snapshot_ciphertext,snapshot_nonce,snapshot_tag,snapshot_key_version)
          VALUES (${applicationId}::uuid,${accountId}::uuid,${driverId}::uuid,${operationId}::uuid,
          'SUBMITTED',${sealedSnapshot.ciphertext},${sealedSnapshot.nonce},${sealedSnapshot.tag},
          ${sealedSnapshot.keyVersion})`;
        await tx.$executeRaw`INSERT INTO driver_provision_receipt(operation_id,command_id,
          account_id,driver_id,application_id,payload_digest,state)
          VALUES (${operationId}::uuid,${command.command_id}::uuid,${accountId}::uuid,
          ${driverId}::uuid,${applicationId}::uuid,${digest},'DRIVER_PROVISIONED')`;
        await tx.$executeRaw`INSERT INTO driver_application_outbox(event_id,application_id,
          aggregate_version,event_type,safe_payload) VALUES (${randomUUID()}::uuid,
          ${applicationId}::uuid,1,'DRIVER_APPLICATION_SUBMITTED',
          ${JSON.stringify({applicationId,driverId})}::jsonb)`;
        await tx.$executeRaw`INSERT INTO driver_application_audit(audit_id,application_id,action)
          VALUES (${randomUUID()}::uuid,${applicationId}::uuid,'SUBMITTED')`;
      });
    } catch(error) {
      const raced=await this.provisionRow(operationId);
      if (raced) {
        if (raced.command_id===command.command_id&&this.crypto.matches('provision',canonical,raced.payload_digest))
          return this.provisionDto(raced);
        throw denied(grpc.status.ALREADY_EXISTS,'PROVISION_CONFLICT');
      }
      if (record(error)&&error.code==='P2002')
        throw denied(grpc.status.ALREADY_EXISTS,'LICENSE_ALREADY_EXISTS');
      throw error;
    }
    const completed=await this.provisionRow(operationId);
    if (!completed) throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return this.provisionDto(completed);
  }
  async getProvision(request:unknown):Promise<Data> {
    const id=record(request)?request.id:undefined;
    if (typeof id!=='string'||!uuid.test(id)) throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const row=await this.provisionRow(id);
    if (!row) throw denied(grpc.status.NOT_FOUND,'PROVISION_NOT_FOUND');
    return this.provisionDto(row);
  }
  async cancelProvision(request:unknown):Promise<Data> {
    if (!record(request)||!record(request.command)||
      ![request.command.operation_id,request.command.command_id,request.account_id,request.driver_id]
        .every(v=>typeof v==='string'&&uuid.test(v)))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const id=request.command.operation_id as string;
    await this.db.$executeRaw`INSERT INTO driver_provision_receipt(operation_id,command_id,
      account_id,driver_id,application_id,payload_digest,state)
      VALUES (${id}::uuid,${request.command.command_id}::uuid,${request.account_id}::uuid,
      ${request.driver_id}::uuid,${randomUUID()}::uuid,${Buffer.alloc(32)},'DRIVER_PROVISION_CANCELLED')
      ON CONFLICT (operation_id) DO NOTHING`;
    const row=await this.provisionRow(id);
    if (!row||row.account_id!==request.account_id||row.driver_id!==request.driver_id)
      throw denied(grpc.status.ALREADY_EXISTS,'PROVISION_CONFLICT');
    if (row.state!=='DRIVER_PROVISION_CANCELLED')
      throw denied(grpc.status.FAILED_PRECONDITION,'PROVISION_ALREADY_CREATED');
    return this.provisionDto(row);
  }
  private async principal(metadata:grpc.Metadata,role:'DRIVER'|'OPERATOR') {
    const token=metadata.get('x-cab-user-authorization')[0];
    if (typeof token!=='string'||!/^Bearer [^\s]+$/.test(token))
      throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    const meta=new grpc.Metadata();meta.set('x-cab-user-authorization',token);
    meta.set('x-correlation-id',randomUUID());
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.identityDefinition,
      'VerifyUserIdentity',{allowed_roles:[role]},meta,900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if (code===grpc.status.UNAUTHENTICATED)
        throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if (code===grpc.status.PERMISSION_DENIED)
        throw denied(grpc.status.PERMISSION_DENIED,'FORBIDDEN','END_USER');
      throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if (value.role!==role||typeof value.account_id!=='string')
      throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return {accountId:value.account_id as string,driverId:value.driver_id as string|undefined,
      token};
  }
  private snapshot(row:Application):Snapshot {
    return JSON.parse(this.crypto.open({ciphertext:row.snapshot_ciphertext,nonce:row.snapshot_nonce,
      tag:row.snapshot_tag,keyVersion:row.snapshot_key_version},row.application_id)) as Snapshot;
  }
  private applicationDto(row:Application):Data {
    const snap=this.snapshot(row);
    return {application_id:row.application_id,account_id:row.account_id,driver_id:row.driver_id,
      status:row.status,applicant:{full_name:snap.fullName,email:snap.email,phone:snap.phone,
        phone_verified_at:stamp(new Date(snap.phoneVerifiedAt)),license_number:snap.licenseNumber},
      submitted_vehicle:{plate_number:snap.plateNumber,vehicle_type:snap.vehicleType},
      version:String(row.version),submitted_at:stamp(row.submitted_at),updated_at:stamp(row.updated_at),
      ...(row.reviewed_at?{reviewed_at:stamp(row.reviewed_at),
        reviewed_by_account_id:row.reviewed_by_account_id}:{}),
      ...(row.rejection_reason?{rejection_reason:row.rejection_reason}:{}),
      ...(row.approved_vehicle_id?{approved_vehicle_id:row.approved_vehicle_id}:{})};
  }
  private async application(id:string):Promise<Application|null> {
    const rows=await this.db.$queryRaw<Application[]>`SELECT * FROM driver_application
      WHERE application_id=${id}::uuid`;
    return rows[0]??null;
  }
  async my(_request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const who=await this.principal(metadata,'DRIVER');
    if (!who.driverId||!uuid.test(who.driverId)) throw denied(grpc.status.NOT_FOUND,'APPLICATION_NOT_FOUND');
    const rows=await this.db.$queryRaw<Application[]>`SELECT * FROM driver_application
      WHERE driver_id=${who.driverId}::uuid AND account_id=${who.accountId}::uuid`;
    if (!rows[0]) throw denied(grpc.status.NOT_FOUND,'APPLICATION_NOT_FOUND');
    return this.applicationDto(rows[0]);
  }
  async list(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    await this.principal(metadata,'OPERATOR');
    const status=record(request)?request.status:undefined;
    const limit=record(request)?request.limit:undefined;
    const cursor=record(request)?request.cursor:undefined;
    if (status!==undefined&&!['SUBMITTED','APPROVED','REJECTED'].includes(String(status))||
        limit!==undefined&&(!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>100)||
        cursor!==undefined&&(typeof cursor!=='string'||cursor.length>256))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const take=Number(limit??20);
    let cursorId:string|undefined;
    if (cursor) {
      try {cursorId=Buffer.from(cursor as string,'base64url').toString('utf8');}
      catch {throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');}
      if (!uuid.test(cursorId)) throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    }
    const rows=await this.db.driverApplication.findMany({
      where:status?{status:String(status)}:{},orderBy:[{submittedAt:'desc'},{applicationId:'desc'}],
      take:take+1,...(cursorId?{cursor:{applicationId:cursorId},skip:1}:{})});
    const items=rows.slice(0,take).map(row=>this.applicationDto({
      application_id:row.applicationId,account_id:row.accountId,driver_id:row.driverId,
      operation_id:row.operationId,status:row.status,snapshot_ciphertext:row.snapshotCiphertext,
      snapshot_nonce:row.snapshotNonce,snapshot_tag:row.snapshotTag,
      snapshot_key_version:row.snapshotKeyVersion,version:row.version,submitted_at:row.submittedAt,
      updated_at:row.updatedAt,reviewed_at:row.reviewedAt,
      reviewed_by_account_id:row.reviewedByAccountId,rejection_reason:row.rejectionReason,
      approved_vehicle_id:row.approvedVehicleId}));
    return {items,...(rows.length>take?{next_cursor:Buffer.from(rows[take-1]!.applicationId).toString('base64url')}:{})};
  }
  async detail(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    await this.principal(metadata,'OPERATOR');
    const id=record(request)?request.application_id:undefined;
    if (typeof id!=='string'||!uuid.test(id)) throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const row=await this.application(id);
    if (!row) throw denied(grpc.status.NOT_FOUND,'APPLICATION_NOT_FOUND');
    return this.applicationDto(row);
  }
  private driverDto(row:Driver,vehicle?:Vehicle):Data {
    return {driver_id:row.driver_id,account_id:row.account_id,
      license_number:this.license.open({ciphertext:row.license_ciphertext,nonce:row.license_nonce,
        tag:row.license_tag,keyVersion:row.license_key_version},row.driver_id),
      approval_status:row.approval_status,driver_status:row.driver_status,
      ...(vehicle?{vehicle_id:vehicle.vehicle_id}:{}),
      ...(row.rejection_reason?{rejection_reason:row.rejection_reason}:{}),
      version:String(row.version),created_at:stamp(row.created_at),updated_at:stamp(row.updated_at)};
  }
  private vehicleDto(row:Vehicle,driverId:string):Data {
    return {vehicle_id:row.vehicle_id,plate_number:row.plate_number,
      vehicle_type:row.vehicle_type,vehicle_status:'VEHICLE_ACTIVE',assigned_driver_id:driverId,
      version:String(row.version),created_at:stamp(row.created_at),updated_at:stamp(row.updated_at)};
  }
  async review(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const who=await this.principal(metadata,'OPERATOR');
    if (!record(request)||typeof request.application_id!=='string'||!uuid.test(request.application_id)||
        !['APPROVED','REJECTED'].includes(String(request.decision))||
        !['expected_version','expected_driver_version'].every(k=>
          typeof request[k]==='string'&&/^[1-9]\d*$/.test(request[k] as string)))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const id=request.application_id,decision=request.decision as string;
    const reason=request.rejection_reason;
    if (decision==='REJECTED'?(typeof reason!=='string'||!reason.trim()||reason.length>1000||
        request.vehicle_id!==undefined||request.expected_vehicle_version!==undefined):
        (reason!==undefined||request.vehicle_id!==undefined||request.expected_vehicle_version!==undefined))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const key=metadata.get('x-cab-idempotency-key')[0];
    if (typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const canonical=JSON.stringify([id,request.expected_version,request.expected_driver_version,
      decision,reason??null]);
    const digest=this.crypto.digest('review',canonical);
    // Identity confirms target Account before opening the Driver transaction.
    const previous=await this.db.$queryRaw<{request_digest:Uint8Array;
      result_ciphertext:Uint8Array;result_nonce:Uint8Array;result_tag:Uint8Array;
      result_key_version:string}[]>`SELECT request_digest,result_ciphertext,result_nonce,
      result_tag,result_key_version FROM driver_review_receipt
      WHERE application_id=${id}::uuid AND idempotency_key=${key}`;
    if (previous[0]) {
      if (!this.crypto.matches('review',canonical,previous[0].request_digest))
        throw denied(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
      return JSON.parse(this.crypto.open({ciphertext:previous[0].result_ciphertext,
        nonce:previous[0].result_nonce,tag:previous[0].result_tag,
        keyVersion:previous[0].result_key_version},id+':review:'+key)) as Data;
    }
    const row=await this.application(id);
    if (!row) throw denied(grpc.status.NOT_FOUND,'APPLICATION_NOT_FOUND');
    const contactMeta=new grpc.Metadata();contactMeta.set('x-cab-user-authorization',who.token);
    contactMeta.set('x-correlation-id',randomUUID());
    let contact:Data;
    try {contact=await unaryCall<object,Data>(this.identity,this.identityDefinition,
      'GetAccountContact',{account_id:row.account_id,purpose:'OPERATIONS_PROFILE'},contactMeta,1000);}
    catch {throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');}
    if (contact.account_status!=='ACTIVE')
      throw denied(grpc.status.PERMISSION_DENIED,'ACCOUNT_NOT_ACTIVE','END_USER');
    return this.db.$transaction(async tx=>{
      const apps=await tx.$queryRaw<Application[]>`SELECT * FROM driver_application
        WHERE application_id=${id}::uuid FOR UPDATE`;
      const app=apps[0];
      if (!app) throw denied(grpc.status.NOT_FOUND,'APPLICATION_NOT_FOUND');
      const receipt=await tx.$queryRaw<{request_digest:Uint8Array;result_ciphertext:Uint8Array;
        result_nonce:Uint8Array;result_tag:Uint8Array;result_key_version:string}[]>`
        SELECT request_digest,result_ciphertext,result_nonce,result_tag,result_key_version
        FROM driver_review_receipt
        WHERE application_id=${id}::uuid AND idempotency_key=${key}`;
      if (receipt[0]) {
        if (!this.crypto.matches('review',canonical,receipt[0].request_digest))
          throw denied(grpc.status.ALREADY_EXISTS,'IDEMPOTENCY_CONFLICT');
        return JSON.parse(this.crypto.open({ciphertext:receipt[0].result_ciphertext,
          nonce:receipt[0].result_nonce,tag:receipt[0].result_tag,
          keyVersion:receipt[0].result_key_version},id+':review:'+key)) as Data;
      }
      if (app.status!=='SUBMITTED') throw denied(grpc.status.ALREADY_EXISTS,'APPLICATION_ALREADY_REVIEWED');
      if (String(app.version)!==request.expected_version)
        throw denied(grpc.status.FAILED_PRECONDITION,'VERSION_CONFLICT');
      const drivers=await tx.$queryRaw<Driver[]>`SELECT * FROM driver_profile
        WHERE driver_id=${app.driver_id}::uuid FOR UPDATE`;
      const driver=drivers[0];
      if (!driver||driver.approval_status!=='PENDING_APPROVAL'||driver.driver_status!=='OFFLINE'||
          String(driver.version)!==request.expected_driver_version)
        throw denied(grpc.status.FAILED_PRECONDITION,'VERSION_CONFLICT');
      const assignment=await tx.$queryRaw<{assignment_id:string}[]>`
        SELECT assignment_id FROM vehicle_assignment WHERE driver_id=${app.driver_id}::uuid
        AND ended_at IS NULL FOR UPDATE`;
      if (assignment[0]) throw denied(grpc.status.ALREADY_EXISTS,'RESOURCE_RESERVED');
      let vehicle:Vehicle|undefined;
      if (decision==='APPROVED') {
        const snap=this.snapshot(app),vehicleId=randomUUID(),plate=snap.plateNumber.trim();
        const rows=await tx.$queryRaw<Vehicle[]>`INSERT INTO vehicle(vehicle_id,plate_number,
          plate_key,vehicle_type,vehicle_status) VALUES (${vehicleId}::uuid,${plate},
          ${plate.toUpperCase()},${snap.vehicleType}::text,'ACTIVE') RETURNING *`;
        vehicle=rows[0];
        if (!vehicle) throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
        await tx.$executeRaw`INSERT INTO vehicle_assignment(assignment_id,driver_id,vehicle_id)
          VALUES (${randomUUID()}::uuid,${app.driver_id}::uuid,${vehicleId}::uuid)`;
      }
      const updated=await tx.$queryRaw<Driver[]>`UPDATE driver_profile
        SET approval_status=${decision}::text,rejection_reason=${decision==='REJECTED'?reason:null},
          version=version+1,updated_at=now() WHERE driver_id=${app.driver_id}::uuid RETURNING *`;
      const appRows=await tx.$queryRaw<Application[]>`UPDATE driver_application
        SET status=${decision}::text,version=version+1,updated_at=now(),reviewed_at=now(),
          reviewed_by_account_id=${who.accountId}::uuid,
          rejection_reason=${decision==='REJECTED'?reason:null},
          approved_vehicle_id=${vehicle?.vehicle_id??null}::uuid
        WHERE application_id=${id}::uuid RETURNING *`;
      const result={application:this.applicationDto(appRows[0]!),driver:this.driverDto(updated[0]!,vehicle),
        ...(vehicle?{vehicle:this.vehicleDto(vehicle,app.driver_id)}:{})};
      const sealed=this.crypto.seal(JSON.stringify(result),id+':review:'+key);
      await tx.$executeRaw`INSERT INTO driver_review_receipt(receipt_id,application_id,
        idempotency_key,request_digest,result_ciphertext,result_nonce,result_tag,result_key_version)
        VALUES (${randomUUID()}::uuid,${id}::uuid,${key},${digest},${sealed.ciphertext},
        ${sealed.nonce},${sealed.tag},${sealed.keyVersion})`;
      await tx.$executeRaw`INSERT INTO driver_application_outbox(event_id,application_id,
        aggregate_version,event_type,safe_payload) VALUES (${randomUUID()}::uuid,
        ${id}::uuid,${app.version+1n},${`DRIVER_APPLICATION_${decision}`}::text,
        ${JSON.stringify({applicationId:id,driverId:app.driver_id})}::jsonb)`;
      await tx.$executeRaw`INSERT INTO driver_application_audit(audit_id,application_id,
        action,actor_account_id) VALUES (${randomUUID()}::uuid,${id}::uuid,
        ${decision}::text,${who.accountId}::uuid)`;
      return result;
    }).catch(error=>{
      if (record(error)&&['P2002','P2010'].includes(String(error.code)))
        throw denied(grpc.status.ALREADY_EXISTS,'PLATE_ALREADY_EXISTS');
      throw error;
    });
  }
}
