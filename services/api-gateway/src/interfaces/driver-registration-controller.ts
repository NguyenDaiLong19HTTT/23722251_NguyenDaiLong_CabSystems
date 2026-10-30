import {randomUUID} from 'node:crypto';
import {Controller,Get,Post,Req,Res,Param} from '@nestjs/common';
import type {Request,Response} from 'express';
import * as grpc from '@grpc/grpc-js';
import {decodeFacadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {isDomesticPhone,publicPhone} from '@cab/phone-number';
import {GatewayGrpcClients} from '../infrastructure/grpc-clients.js';
import {driver,vehicle,iso,version} from './driver-controller.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const identity=serviceDefinition('cab.gateway.v1.IdentityDriverRegistrationFacadeService',
  'proto/cab/gateway/v1/driver_registration_facade.proto');
const applications=serviceDefinition('cab.gateway.v1.DriverApplicationFacadeService',
  'proto/cab/gateway/v1/driver_registration_facade.proto');
const keyPattern=/^[A-Za-z0-9._:-]{1,128}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errors:Record<string,{status:number;grpc:grpc.status}>={
  VALIDATION_ERROR:{status:400,grpc:grpc.status.INVALID_ARGUMENT},
  OTP_INVALID_OR_EXPIRED:{status:400,grpc:grpc.status.INVALID_ARGUMENT},
  VERIFICATION_TOKEN_INVALID_OR_EXPIRED:{status:400,grpc:grpc.status.INVALID_ARGUMENT},
  OTP_ALREADY_VERIFIED:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  CONTACT_ALREADY_EXISTS:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  LICENSE_ALREADY_EXISTS:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  VERIFICATION_TOKEN_USED:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  IDEMPOTENCY_CONFLICT:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  IDEMPOTENCY_KEY_EXPIRED:{status:409,grpc:grpc.status.FAILED_PRECONDITION},
  REGISTRATION_FAILED:{status:409,grpc:grpc.status.FAILED_PRECONDITION},
  REGISTRATION_PROOF_REQUIRED:{status:401,grpc:grpc.status.UNAUTHENTICATED},
  REGISTRATION_OPERATION_NOT_FOUND:{status:404,grpc:grpc.status.NOT_FOUND},
  UNAUTHENTICATED:{status:401,grpc:grpc.status.UNAUTHENTICATED},
  FORBIDDEN:{status:403,grpc:grpc.status.PERMISSION_DENIED},
  ACCOUNT_NOT_ACTIVE:{status:403,grpc:grpc.status.PERMISSION_DENIED},
  APPLICATION_NOT_FOUND:{status:404,grpc:grpc.status.NOT_FOUND},
  APPLICATION_ALREADY_REVIEWED:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  VERSION_CONFLICT:{status:409,grpc:grpc.status.FAILED_PRECONDITION},
  RESOURCE_RESERVED:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  PLATE_ALREADY_EXISTS:{status:409,grpc:grpc.status.ALREADY_EXISTS},
  RATE_LIMIT_EXCEEDED:{status:429,grpc:grpc.status.RESOURCE_EXHAUSTED},
};
function otpChallenge(v:unknown):Data {
  if (!record(v)||typeof v.challenge_id!=='string'||v.purpose!=='DRIVER_REGISTRATION'||
      v.status!=='ACCEPTED'||(v.otp!==undefined&&
        (typeof v.otp!=='string'||!/^\d{6}$/.test(v.otp)))) throw new Error('Invalid OTP challenge');
  return {challengeId:v.challenge_id,purpose:v.purpose,status:v.status,
    createdAt:iso(v.created_at),expiresAt:iso(v.expires_at),
    resendAvailableAt:iso(v.resend_available_at),
    ...(process.env.NODE_ENV==='development'&&process.env.CAB_DEMO_OTP_RESPONSE_ENABLED==='1'&&
      typeof v.otp==='string'?{otp:v.otp}:{})};
}
function verification(v:unknown):Data {
  if (!record(v)||typeof v.verification_token!=='string'||v.verification_token.length<32||
      v.purpose!=='DRIVER_REGISTRATION'||typeof v.verified_phone!=='string'||
      !v.verified_phone) throw new Error('Invalid phone verification');
  return {verificationToken:v.verification_token,purpose:v.purpose,verifiedPhone:publicPhone(v.verified_phone),
    verifiedAt:iso(v.verified_at),expiresAt:iso(v.expires_at)};
}
function registrationResult(v:unknown):Data {
  if (!record(v)||![v.account_id,v.driver_id,v.application_id].every(x=>typeof x==='string'&&x)||
      v.account_status!=='ACTIVE'||v.approval_status!=='PENDING_APPROVAL'||
      v.driver_status!=='OFFLINE'||v.application_status!=='SUBMITTED')
    throw new Error('Invalid Driver registration result');
  return {accountId:v.account_id,driverId:v.driver_id,applicationId:v.application_id,
    accountStatus:v.account_status,approvalStatus:v.approval_status,
    driverStatus:v.driver_status,applicationStatus:v.application_status,
    submittedAt:iso(v.submitted_at)};
}
function operation(v:unknown):Data {
  if (!record(v)||typeof v.operation_id!=='string'||
      !['PROCESSING','SUCCEEDED','FAILED'].includes(String(v.status)))
    throw new Error('Invalid Driver operation');
  const out:Data={operationId:v.operation_id,status:v.status,
    createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)};
  if (v.status==='SUCCEEDED') out.result=registrationResult(v.result);
  else if (v.status==='FAILED') {
    if (typeof v.error_code!=='string') throw new Error('Invalid Driver failure');
    out.error={errorCode:v.error_code,message:'Registration could not be completed'};
  } else if (v.result!==undefined||v.error_code!==undefined)
    throw new Error('Processing leaked a result');
  return out;
}
function application(v:unknown):Data {
  if (!record(v)||![v.application_id,v.account_id,v.driver_id].every(x=>typeof x==='string'&&x)||
      !['SUBMITTED','APPROVED','REJECTED'].includes(String(v.status))||
      !record(v.applicant)||!record(v.submitted_vehicle)||
      ![v.applicant.full_name,v.applicant.email,v.applicant.phone,v.applicant.license_number,
        v.submitted_vehicle.plate_number].every(x=>typeof x==='string'&&x)||
      !['STANDARD','PREMIUM','MOTORBIKE','VAN'].includes(String(v.submitted_vehicle.vehicle_type)))
    throw new Error('Invalid Driver application');
  const result:Data={applicationId:v.application_id,accountId:v.account_id,driverId:v.driver_id,
    status:v.status,applicant:{fullName:v.applicant.full_name,email:v.applicant.email,
      phone:publicPhone(v.applicant.phone as string),phoneVerifiedAt:iso(v.applicant.phone_verified_at),
      licenseNumber:v.applicant.license_number},
    submittedVehicle:{plateNumber:v.submitted_vehicle.plate_number,
      vehicleType:v.submitted_vehicle.vehicle_type},version:version(v.version),
    submittedAt:iso(v.submitted_at),updatedAt:iso(v.updated_at)};
  if (v.status==='SUBMITTED') {
    if (v.reviewed_at||v.rejection_reason||v.approved_vehicle_id) throw new Error('Invalid submitted state');
  } else {
    if (typeof v.reviewed_by_account_id!=='string') throw new Error('Missing reviewer');
    result.reviewedAt=iso(v.reviewed_at);result.reviewedByAccountId=v.reviewed_by_account_id;
    if (v.status==='REJECTED') {
      if (typeof v.rejection_reason!=='string'||!v.rejection_reason||v.approved_vehicle_id)
        throw new Error('Invalid rejected state');
      result.rejectionReason=v.rejection_reason;
    } else {
      if (typeof v.approved_vehicle_id!=='string'||v.rejection_reason)
        throw new Error('Invalid approved state');
      result.approvedVehicleId=v.approved_vehicle_id;
    }
  }
  return result;
}
function reviewResult(v:unknown):Data {
  if (!record(v)) throw new Error('Invalid review result');
  const app=application(v.application),d=driver(v.driver);
  if (app.driverId!==d.driverId||app.accountId!==d.accountId||
      app.status!==d.approvalStatus) throw new Error('Review binding mismatch');
  if (app.status==='APPROVED') {
    const car=vehicle(v.vehicle);
    if (car.vehicleId!==d.vehicleId||car.vehicleId!==app.approvedVehicleId)
      throw new Error('Review vehicle mismatch');
    return {application:app,driver:d,vehicle:car};
  }
  if (v.vehicle!==undefined||d.vehicleId!==null) throw new Error('Rejected review vehicle');
  return {application:app,driver:d};
}

@Controller('v1')
export class DriverRegistrationController {
  private readonly counts=new Map<string,{count:number;until:number}>();
  constructor(private readonly clients:GatewayGrpcClients) {}
  private limit(req:Request,res:Response,name:string):boolean {
    const key=`${name}:${req.ip}`,now=Date.now();
    const slot=this.counts.get(key);const current=slot&&slot.until>now?slot:{count:0,until:now+60000};
    current.count++;this.counts.set(key,current);
    if (current.count>30) {res.setHeader('Retry-After',String(Math.ceil((current.until-now)/1000)));
      res.status(429).json({errorCode:'RATE_LIMIT_EXCEEDED',message:'Too many requests'});return false;}
    return true;
  }
  private invalid(res:Response):void {res.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});}
  private auth(req:Request,res:Response):boolean {
    if (!/^Bearer [^\s]+$/.test(req.header('Authorization')??'')) {
      res.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return false;}
    return true;
  }
  private async call(owner:'identity-service'|'driver-service',definition:grpc.ServiceDefinition<grpc.UntypedServiceImplementation>,
    method:string,payload:Data,req:Request,res:Response,registrationKey?:string,
    internalKey?:string):Promise<Data|undefined> {
    try {
      const target=process.env[owner==='identity-service'?'IDENTITY_SERVICE_GRPC_TARGET':'DRIVER_SERVICE_GRPC_TARGET'];
      if (!target) throw new Error('gRPC target missing');
      const meta=new grpc.Metadata();meta.set('x-correlation-id',randomUUID());
      if (req.header('Authorization')) meta.set('x-cab-user-authorization',req.header('Authorization')!);
      if (['SubmitDriverApplication','GetDriverRegistrationOperation'].includes(method) &&
          (registrationKey ?? req.header('Idempotency-Key')))
        meta.set('x-cab-registration-idempotency-key',(registrationKey ?? req.header('Idempotency-Key'))!);
      if (req.header('Driver-Registration-Token'))
        meta.set('x-cab-driver-verification-token',req.header('Driver-Registration-Token')!);
      if (method==='ReviewDriverApplication')
        meta.set('x-cab-idempotency-key',internalKey!);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),owner);
      return await unaryCall<Data,Data>(client,definition,method,payload,meta,3000);
    } catch(error) {
      const failure=decodeFacadeError(error as grpc.ServiceError),reason=failure?.reason;
      const known=reason?errors[reason]:undefined;
      const safe=known&&failure?.code===known.grpc&&
        (![401,403,404].includes(known.status)||failure?.origin==='END_USER'||
          known.status===404&&reason==='APPLICATION_NOT_FOUND');
      res.status(safe?known.status:503).json({errorCode:safe?reason:'SERVICE_UNAVAILABLE',
        message:safe?'Request could not be completed':'Service temporarily unavailable'});
      return undefined;
    }
  }
  private render(res:Response,status:number,value:unknown,mapper:(v:unknown)=>Data):void {
    try {res.status(status).json(mapper(value));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Post('auth/driver-registration/otp')
  async requestOtp(@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'otp-request')) return;
    if (!record(req.body)||Object.keys(req.body).join(',')!=='phone'||
        !isDomesticPhone(req.body.phone)) return this.invalid(res);
    const value=await this.call('identity-service',identity,'RequestDriverOtp',
      {phone:req.body.phone},req,res);
    if (value) this.render(res,202,value,otpChallenge);
  }
  @Post('auth/driver-registration/otp/verify')
  async verifyOtp(@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'otp-verify')) return;
    if (!record(req.body)||Object.keys(req.body).sort().join(',')!=='challengeId,otp'||
        typeof req.body.challengeId!=='string'||!uuid.test(req.body.challengeId)||
        typeof req.body.otp!=='string'||!/^\d{6}$/.test(req.body.otp)) return this.invalid(res);
    const value=await this.call('identity-service',identity,'VerifyDriverOtp',
      {challenge_id:req.body.challengeId,otp:req.body.otp},req,res);
    if (value) this.render(res,200,value,verification);
  }
  @Post('driver-applications')
  async submit(@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'driver-submit')) return;
    const body=req.body,key=req.header('Idempotency-Key');
    if (!record(body)||Object.keys(body).sort().join(',')!==
        'email,fullName,licenseNumber,password,vehicle,verificationToken'||
        !record(body.vehicle)||Object.keys(body.vehicle).sort().join(',')!=='plateNumber,vehicleType'||
        ![body.verificationToken,body.fullName,body.email,body.password,body.licenseNumber,
          body.vehicle.plateNumber].every(x=>typeof x==='string'&&x)||
        body.vehicle.vehicleType!=='MOTORBIKE'||
        (key!==undefined&&!keyPattern.test(key))) return this.invalid(res);
    const value=await this.call('identity-service',identity,'SubmitDriverApplication',{
      verification_token:body.verificationToken,full_name:body.fullName,email:body.email,
      password:body.password,license_number:body.licenseNumber,
      vehicle:{plate_number:body.vehicle.plateNumber,vehicle_type:body.vehicle.vehicleType}},req,res,
      key??randomUUID());
    if (!value) return;
    try {
      if (record(value.created)) {
        res.setHeader('Location','/v1/driver-applications/me');
        res.status(201).json(registrationResult(value.created));
      } else if (record(value.processing)) {
        const op=operation(value.processing);
        if (op.status!=='PROCESSING') throw new Error('Invalid processing status');
        res.setHeader('Location',`/v1/driver-registration-operations/${op.operationId}`);
        res.setHeader('Retry-After','1');res.status(202).json(op);
      } else throw new Error('Missing registration outcome');
    } catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('driver-registration-operations/:operationId')
  async lookup(@Param('operationId') id:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'driver-lookup')) return;
    if (!req.header('Driver-Registration-Token')) {
      res.status(401).json({errorCode:'REGISTRATION_PROOF_REQUIRED',message:'Proof required'});return;}
    if (!uuid.test(id)) {
      res.status(404).json({errorCode:'REGISTRATION_OPERATION_NOT_FOUND',message:'Not found'});return;}
    const value=await this.call('identity-service',identity,'GetDriverRegistrationOperation',
      {operation_id:id},req,res);
    if (value) this.render(res,200,value,operation);
  }
  @Get('driver-applications/me')
  async me(@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'driver-application-me')||!this.auth(req,res)) return;
    const value=await this.call('driver-service',applications,'GetMyDriverApplication',{},req,res);
    if (value) this.render(res,200,value,application);
  }
  @Get('operations/driver-applications')
  async list(@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'driver-application-list')||!this.auth(req,res)) return;
    const status=req.query.status,limit=req.query.limit,cursor=req.query.cursor;
    if (status!==undefined&&!['SUBMITTED','APPROVED','REJECTED'].includes(String(status))||
        limit!==undefined&&(!/^\d+$/.test(String(limit))||Number(limit)<1||Number(limit)>100)||
        cursor!==undefined&&(typeof cursor!=='string'||cursor.length>256)) return this.invalid(res);
    const value=await this.call('driver-service',applications,'ListDriverApplications',{
      ...(status?{status:String(status)}:{}),...(limit?{limit:Number(limit)}:{}),
      ...(cursor?{cursor:String(cursor)}:{})},req,res);
    if (value) this.render(res,200,value,v=>{
      if (!record(v)||!Array.isArray(v.items)) throw new Error('Invalid application page');
      return {items:v.items.map(application),nextCursor:typeof v.next_cursor==='string'?v.next_cursor:null};
    });
  }
  @Get('operations/driver-applications/:applicationId')
  async detail(@Param('applicationId') id:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'driver-application-detail')||!this.auth(req,res)) return;
    if (!uuid.test(id)) return this.invalid(res);
    const value=await this.call('driver-service',applications,'GetDriverApplication',
      {application_id:id},req,res);
    if (value) this.render(res,200,value,application);
  }
  @Post('operations/driver-applications/:applicationId/review')
  async review(@Param('applicationId') id:string,@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res,'driver-application-review')||!this.auth(req,res)) return;
    const body=req.body,key=req.header('Idempotency-Key');
    if (!uuid.test(id)||!record(body)||(key!==undefined&&!keyPattern.test(key))||
        !Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||
        !Number.isSafeInteger(body.expectedDriverVersion)||Number(body.expectedDriverVersion)<1||
        !['APPROVED','REJECTED'].includes(String(body.decision))||
        (body.decision==='REJECTED'?
          (Object.keys(body).sort().join(',')!=='decision,expectedDriverVersion,expectedVersion,rejectionReason'||
            typeof body.rejectionReason!=='string'||!body.rejectionReason.trim()||
            body.rejectionReason.length>1000):
          Object.keys(body).sort().join(',')!=='decision,expectedDriverVersion,expectedVersion'))
      return this.invalid(res);
    const value=await this.call('driver-service',applications,'ReviewDriverApplication',{
      application_id:id,expected_version:String(body.expectedVersion),
      expected_driver_version:String(body.expectedDriverVersion),decision:body.decision,
      ...(body.decision==='REJECTED'?{rejection_reason:body.rejectionReason}:{})},
      req,res,undefined,key??randomUUID());
    if (value) this.render(res,200,value,reviewResult);
  }
}
