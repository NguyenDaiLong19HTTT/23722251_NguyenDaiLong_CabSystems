import {randomUUID} from 'node:crypto';
import {Controller,Get,Patch,Param,Req,Res} from '@nestjs/common';
import type {Request,Response} from 'express';
import * as grpc from '@grpc/grpc-js';
import {decodeFacadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {GatewayGrpcClients} from '../infrastructure/grpc-clients.js';
import {iso} from './driver-controller.js';

type Data=Record<string,unknown>;
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const definition=serviceDefinition('cab.gateway.v1.NotificationFacadeService',
  'proto/cab/gateway/v1/notification_facade.proto');
const id=/^[A-Za-z0-9._:-]{1,128}$/;
function item(v:unknown):Data {
  if (!record(v)||![v.notification_id,v.event_id,v.recipient_account_id,v.event_type,
      v.reference_type,v.reference_id,v.title,v.message].every(x=>typeof x==='string'&&x)||
      v.channel!=='IN_APP'||v.delivery_status!=='SENT'||typeof v.is_read!=='boolean')
    throw new Error('Invalid Notification item');
  const out:Data={notificationId:v.notification_id,eventId:v.event_id,
    recipientAccountId:v.recipient_account_id,eventType:v.event_type,
    referenceType:v.reference_type,referenceId:v.reference_id,channel:v.channel,
    deliveryStatus:v.delivery_status,title:v.title,message:v.message,isRead:v.is_read,
    occurredAt:iso(v.occurred_at),createdAt:iso(v.created_at),publishedAt:iso(v.published_at)};
  if (v.is_read) out.readAt=iso(v.read_at);
  else if (v.read_at!==undefined) throw new Error('Unread Notification has readAt');
  return out;
}
function page(v:unknown):Data {
  if (!record(v)) throw new Error('Invalid Notification page');
  // A protobuf repeated field is absent on the wire when the list is empty.
  const items=v.items??[];
  if (!Array.isArray(items)||items.length>100||
      (v.next_cursor!==undefined&&typeof v.next_cursor!=='string'))
    throw new Error('Invalid Notification page');
  return {items:items.map(item),nextCursor:v.next_cursor??null};
}

@Controller('v1')
export class NotificationController {
  private readonly counts=new Map<string,{count:number;until:number}>();
  constructor(private readonly clients:GatewayGrpcClients) {}
  private limit(req:Request,res:Response):boolean {
    const key=`notification:${req.ip}`,now=Date.now(),old=this.counts.get(key);
    const current=old&&old.until>now?old:{count:0,until:now+60000};
    current.count++;this.counts.set(key,current);
    if (current.count>30) {
      res.setHeader('Retry-After',String(Math.ceil((current.until-now)/1000)));
      res.status(429).json({errorCode:'RATE_LIMIT_EXCEEDED',message:'Too many requests'});return false;
    }
    return true;
  }
  private invalid(res:Response):void {
    res.status(400).json({errorCode:'VALIDATION_ERROR',message:'Invalid request'});
  }
  private async call(method:string,payload:Data,req:Request,res:Response):Promise<Data|undefined> {
    const token=req.header('Authorization');
    if (!token||!/^Bearer [^\s]+$/.test(token)) {
      res.status(401).json({errorCode:'UNAUTHENTICATED',message:'Invalid session'});return;
    }
    try {
      const target=process.env.NOTIFICATION_SERVICE_GRPC_TARGET;
      if (!target) throw new Error('Notification target missing');
      const meta=new grpc.Metadata();
      meta.set('x-correlation-id',randomUUID());
      meta.set('x-cab-user-authorization',token);
      const client=this.clients.connect(target,readTlsFromEnvironment('API_GATEWAY'),
        'notification-service');
      return await unaryCall<Data,Data>(client,definition,method,payload,meta,3000);
    } catch(error) {
      const result=decodeFacadeError(error as grpc.ServiceError);
      const mapping:Record<string,{code:grpc.status;http:number}>={
        VALIDATION_ERROR:{code:grpc.status.INVALID_ARGUMENT,http:400},
        UNAUTHENTICATED:{code:grpc.status.UNAUTHENTICATED,http:401},
        FORBIDDEN:{code:grpc.status.PERMISSION_DENIED,http:403},
        NOTIFICATION_NOT_FOUND:{code:grpc.status.NOT_FOUND,http:404}};
      const entry=result?.reason?mapping[result.reason]:undefined;
      const safe=entry&&result?.code===entry.code&&result.origin==='END_USER';
      res.status(safe?entry.http:503).json({errorCode:safe?result.reason:'SERVICE_UNAVAILABLE',
        message:safe?'Request could not be completed':'Service temporarily unavailable'});
      return;
    }
  }
  @Get('notifications')
  async list(@Req() req:Request,@Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res)) return;
    const keys=Object.keys(req.query);
    if (keys.some(key=>!['isRead','limit','cursor'].includes(key))||
        req.query.isRead!==undefined&&!['true','false'].includes(String(req.query.isRead))||
        req.query.limit!==undefined&&(!/^\d+$/.test(String(req.query.limit))||
          Number(req.query.limit)<1||Number(req.query.limit)>100)||
        req.query.cursor!==undefined&&(typeof req.query.cursor!=='string'||
          req.query.cursor.length<1||req.query.cursor.length>2048)) return this.invalid(res);
    const value=await this.call('ListMyNotifications',{
      limit:req.query.limit?Number(req.query.limit):20,
      ...(req.query.isRead!==undefined?{is_read:req.query.isRead==='true'}:{}),
      ...(req.query.cursor?{cursor:req.query.cursor}:{})},req,res);
    if (value) try {res.status(200).json(page(value));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Invalid service response'});}
  }
  @Patch('notifications/:notificationId/read')
  async read(@Param('notificationId') notificationId:string,@Req() req:Request,
    @Res() res:Response):Promise<void> {
    res.setHeader('Cache-Control','no-store');
    if (!this.limit(req,res)) return;
    if (!id.test(notificationId)||Object.keys(req.query).length||
        req.headers['transfer-encoding']!==undefined||
        (req.headers['content-length']!==undefined&&Number(req.headers['content-length'])>0)||
        (record(req.body)&&Object.keys(req.body).length>0)) return this.invalid(res);
    const value=await this.call('MarkMyNotificationRead',{notification_id:notificationId},req,res);
    if (value) try {res.status(200).json(item(value));}
    catch {res.status(503).json({errorCode:'SERVICE_UNAVAILABLE',message:'Invalid service response'});}
  }
}
