import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as grpc from '@grpc/grpc-js';
import { decodeFacadeError, readTlsFromEnvironment, serviceDefinition, unaryCall } from '@cab/grpc-transport';
import {isDomesticPhone,publicPhone} from '@cab/phone-number';
import { GatewayGrpcClients } from '../infrastructure/grpc-clients.js';

type Data = Record<string,unknown>;
const facade = serviceDefinition('cab.gateway.v1.IdentityFacadeService',
  'proto/cab/gateway/v1/customer_facade.proto');
const customerFacade = serviceDefinition('cab.gateway.v1.CustomerFacadeService',
  'proto/cab/gateway/v1/customer_facade.proto');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recoveryPattern = /^[A-Za-z0-9_-]{43}$/;
const timings:Record<string,number> = {RegisterCustomer:4000,GetCustomerRegistration:1000,
  Login:2000,GetMyAccount:1000,GetCustomer:3000};
const errorMap:Record<string,Record<string,number>> = {
  RegisterCustomer:{VALIDATION_ERROR:400,REGISTRATION_RECOVERY_INVALID:401,CONTACT_CONFLICT:409,
    IDEMPOTENCY_CONFLICT:409,IDEMPOTENCY_KEY_EXPIRED:409,REGISTRATION_FAILED:409},
  GetCustomerRegistration:{REGISTRATION_RECOVERY_INVALID:401,REGISTRATION_NOT_FOUND:404},
  Login:{VALIDATION_ERROR:400,INVALID_CREDENTIALS:401,ACCOUNT_NOT_ACTIVE:403,
    REGISTRATION_IN_PROGRESS:409},
  GetMyAccount:{UNAUTHENTICATED:401,ACCOUNT_NOT_ACTIVE:403},
  GetCustomer:{VALIDATION_ERROR:400,UNAUTHENTICATED:401,FORBIDDEN:403,
    ACCOUNT_NOT_ACTIVE:403,CUSTOMER_NOT_FOUND:404},
};
const grpcCode:Record<string,grpc.status> = {
  VALIDATION_ERROR:grpc.status.INVALID_ARGUMENT,
  REGISTRATION_RECOVERY_INVALID:grpc.status.UNAUTHENTICATED,
  INVALID_CREDENTIALS:grpc.status.UNAUTHENTICATED,UNAUTHENTICATED:grpc.status.UNAUTHENTICATED,
  CONTACT_CONFLICT:grpc.status.ALREADY_EXISTS,IDEMPOTENCY_CONFLICT:grpc.status.ALREADY_EXISTS,
  IDEMPOTENCY_KEY_EXPIRED:grpc.status.FAILED_PRECONDITION,
  REGISTRATION_FAILED:grpc.status.FAILED_PRECONDITION,
  REGISTRATION_IN_PROGRESS:grpc.status.FAILED_PRECONDITION,
  ACCOUNT_NOT_ACTIVE:grpc.status.PERMISSION_DENIED,FORBIDDEN:grpc.status.PERMISSION_DENIED,
  REGISTRATION_NOT_FOUND:grpc.status.NOT_FOUND,CUSTOMER_NOT_FOUND:grpc.status.NOT_FOUND,
};
function record(value:unknown):value is Data { return typeof value==='object' && value!==null && !Array.isArray(value); }
function iso(value:unknown):string {
  if (!record(value) || !/^\d+$/.test(String(value.seconds)) ||
      typeof value.nanos !== 'number' || value.nanos<0 || value.nanos>=1e9)
    throw new Error('Invalid timestamp');
  return new Date(Number(value.seconds)*1000+Math.floor(value.nanos/1e6)).toISOString();
}
function account(value:unknown):Data {
  if (!record(value) || !['CUSTOMER','DRIVER','OPERATOR'].includes(String(value.role)) ||
      !['ACTIVE','INACTIVE','SUSPENDED'].includes(String(value.account_status)))
    throw new Error('Invalid Account response');
  const profile = value.role==='CUSTOMER'?'customer_id':value.role==='DRIVER'?'driver_id':'operator_id';
  if (![value.account_id,value.full_name,value.email,value.phone,value[profile]].every(v=>typeof v==='string' && v))
    throw new Error('Incomplete Account response');
  return {accountId:value.account_id,fullName:value.full_name,email:value.email,phone:publicPhone(value.phone as string),
    role:value.role,accountStatus:value.account_status,
    [profile==='customer_id'?'customerId':profile==='driver_id'?'driverId':'operatorId']:value[profile],
    createdAt:iso(value.created_at),updatedAt:iso(value.updated_at)};
}
function operation(value:unknown):Data {
  if (!record(value) || typeof value.operation_id!=='string' ||
      !['PROCESSING','SUCCEEDED','FAILED'].includes(String(value.status)))
    throw new Error('Invalid operation response');
  const result:Data={operationId:value.operation_id,status:value.status,
    createdAt:iso(value.created_at),updatedAt:iso(value.updated_at)};
  if (value.status==='SUCCEEDED') result.result=account(value.result);
  if (value.status==='FAILED') {
    if (!record(value.error) || typeof value.error.error_code!=='string' ||
        typeof value.error.message!=='string') throw new Error('Invalid terminal error');
    result.error={errorCode:value.error.error_code,message:value.error.message};
  }
  return result;
}

@Controller('v1')
export class CustomerController {
  private readonly limits = new Map<string,{count:number;until:number}>();
  constructor(private readonly clients:GatewayGrpcClients) {}
  private limit(request:Request,response:Response,method:string):boolean {
    const key = `${method}:${request.ip}`;
    const now=Date.now(),current=this.limits.get(key);
    const slot=current && current.until>now ? current:{count:0,until:now+60000};
    slot.count++;this.limits.set(key,slot);
    if (this.limits.size>10000) for (const [id,value] of this.limits)
      if (value.until<=now) this.limits.delete(id);
    if (slot.count>30) {response.setHeader('Retry-After',String(Math.max(1,Math.ceil((slot.until-now)/1000))));
      response.status(429).json({errorCode:'RATE_LIMIT_EXCEEDED',message:'Too many requests'});return false;}
    return true;
  }
  private async call(method:string,body:Data,request:Request,response:Response,owner:'identity-service'|'customer-service',
    registration?:{key:string;recovery:string}):Promise<Data|undefined> {
    response.setHeader('Cache-Control','no-store');
    try {
      const target=process.env[owner==='identity-service'?'IDENTITY_SERVICE_GRPC_TARGET':'CUSTOMER_SERVICE_GRPC_TARGET'];
      if (!target) throw new Error('Missing owner target');
      const metadata=new grpc.Metadata();metadata.set('x-correlation-id',randomUUID());
      const rawHeader=(name:string)=>request.header(name);
      if (method==='RegisterCustomer') {
        if (!registration) throw new Error('Missing registration proof');
        metadata.set('x-cab-registration-idempotency-key',registration.key);
        metadata.set('x-cab-registration-recovery-token',registration.recovery);
      }
      if (method==='GetCustomerRegistration')
        metadata.set('x-cab-registration-recovery-token',rawHeader('Registration-Recovery-Token')!);
      if (method==='GetMyAccount' || method==='GetCustomer')
        metadata.set('x-cab-user-authorization',rawHeader('Authorization')!);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),owner);
      return await unaryCall<Data,Data>(client,owner==='identity-service'?facade:customerFacade,
        method,body,metadata,timings[method]!);
    } catch (error) {
      const failure=decodeFacadeError(error as grpc.ServiceError);
      const reason=failure?.reason;
      const mapped=reason && failure?.code===grpcCode[reason] &&
        (failure.code!==grpc.status.UNAUTHENTICATED || failure.origin==='END_USER') ?
        errorMap[method]?.[reason] : undefined;
      const status=mapped ?? 503;
      response.status(status).json({errorCode:mapped?reason:'SERVICE_UNAVAILABLE',
        message:mapped?'Request could not be completed':'Service temporarily unavailable'});
      return undefined;
    }
  }
  @Post('auth/register')
  async register(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'register')) return;
    const body=request.body;
    if (!record(body) || Object.keys(body).sort().join(',')!=='email,fullName,password,phone' ||
        !Object.values(body).every(v=>typeof v==='string') ||
        !(body.fullName as string).trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((body.email as string).trim()) ||
        !isDomesticPhone(body.phone) || (body.password as string).length<8 ||
        !/\S/.test(body.password as string)) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    const suppliedKey=request.header('Idempotency-Key');
    const suppliedRecovery=request.header('Registration-Recovery-Token');
    if (suppliedKey && !uuid.test(suppliedKey) || Boolean(suppliedKey)!==Boolean(suppliedRecovery)) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    if (suppliedRecovery && !recoveryPattern.test(suppliedRecovery)) {
      response.status(401).json({errorCode:'REGISTRATION_RECOVERY_INVALID',message:'Invalid recovery token'});return;
    }
    const registration={key:suppliedKey??randomUUID(),
      recovery:suppliedRecovery??randomBytes(32).toString('base64url')};
    const result=await this.call('RegisterCustomer',{full_name:(body.fullName as string).trim(),
      email:(body.email as string).trim().toLowerCase(),phone:body.phone,password:body.password},request,response,'identity-service',registration);
    if (!result) return;
    try {
      if (result.created) {response.status(201).json(account(result.created));return;}
      if (record(result.processing) && Number.isInteger(result.processing.retry_after_seconds) &&
          Number(result.processing.retry_after_seconds)>=1) {
        const op=operation(result.processing.operation);
        if (op.status!=='PROCESSING') throw new Error('Invalid 202');
        response.setHeader('Location',`/v1/auth/customer-registrations/${encodeURIComponent(String(op.operationId))}`);
        response.setHeader('Retry-After',String(result.processing.retry_after_seconds));
        response.setHeader('Registration-Recovery-Token',registration.recovery);
        response.status(202).json(op);return;
      }
      throw new Error('Invalid register response');
    } catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('auth/customer-registrations/:operationId')
  async lookup(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'lookup')) return;
    const token=request.header('Registration-Recovery-Token');
    if (!recoveryPattern.test(token??'')) {response.status(401).json({errorCode:'REGISTRATION_RECOVERY_INVALID',message:'Invalid recovery token'});return;}
    const id=String(request.params.operationId ?? '');
    if (!id || id.length>128) {response.status(404).json({errorCode:'REGISTRATION_NOT_FOUND',message:'Registration not found'});return;}
    const result=await this.call('GetCustomerRegistration',{operation_id:id},request,response,'identity-service');
    if (!result) return;
    try {response.status(200).json(operation(result));}
    catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Post('auth/login')
  async login(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!this.limit(request,response,'login')) return;
    const body=request.body;
    if (!record(body) || Object.keys(body).sort().join(',')!=='emailOrPhone,password' ||
        typeof body.emailOrPhone!=='string' ||
        !(isDomesticPhone(String(body.emailOrPhone)) ||
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.emailOrPhone.trim())) ||
        typeof body.password!=='string' || !body.password) {
      response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});return;
    }
    const result=await this.call('Login',{email_or_phone:body.emailOrPhone,password:body.password},
      request,response,'identity-service');
    if (!result) return;
    try {
      if (typeof result.access_token!=='string' || typeof result.refresh_token!=='string' ||
          result.token_type!=='BEARER' || !Number.isInteger(result.expires_in) ||
          Number(result.expires_in)<1 || Number(result.expires_in)>900) throw new Error('Invalid Session');
      response.status(200).json({accessToken:result.access_token,refreshToken:result.refresh_token,
        tokenType:'Bearer',expiresIn:result.expires_in,sessionExpiresAt:iso(result.session_expires_at),
        account:account(result.account)});
    } catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('accounts/me')
  async me(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!/^Bearer [^\s]+$/.test(request.header('Authorization')??'')) {
      response.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return;}
    const result=await this.call('GetMyAccount',{},request,response,'identity-service');
    if (!result) return;
    try {response.status(200).json(account(result));}
    catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
  @Get('customers/:customerId')
  async customer(@Req() request:Request,@Res() response:Response):Promise<void> {
    response.setHeader('Cache-Control','no-store');
    if (!/^Bearer [^\s]+$/.test(request.header('Authorization')??'')) {
      response.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return;}
    const id=String(request.params.customerId??'');
    if (!id) {response.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid customer ID'});return;}
    const result=await this.call('GetCustomer',{customer_id:id},request,response,'customer-service');
    if (!result) return;
    try {response.status(200).json(account(result));}
    catch {response.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable'});}
  }
}
