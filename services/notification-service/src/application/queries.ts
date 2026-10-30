import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Injectable} from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import {NotificationMongoStore,type Notice} from '../infrastructure/mongo-store.js';

type Data=Record<string,unknown>;
const record=(value:unknown):value is Data=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const denied=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>
  facadeError(code,reason,origin);
const ts=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),nanos:(date.getTime()%1000)*1e6});
const identifier=/^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class NotificationQueries {
  private readonly identity:grpc.Client;
  private readonly definition=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  private readonly cursorKey:Buffer;
  constructor(private readonly store:NotificationMongoStore) {
    const target=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    const keyFile=process.env.CAB_NOTIFICATION_CURSOR_KEY_FILE;
    if (!target||!keyFile) throw new Error('Notification identity/cursor configuration missing');
    this.identity=createClient(target,readTlsFromEnvironment('NOTIFICATION_SERVICE'),'identity-service');
    this.cursorKey=Buffer.from(readFileSync(keyFile,'utf8').trim(),'base64url');
    if (this.cursorKey.length!==32) throw new Error('Notification cursor key invalid');
  }
  close():void {this.identity.close();}
  private async principal(metadata:grpc.Metadata):Promise<string> {
    const user=metadata.get('x-cab-user-authorization')[0];
    if (typeof user!=='string'||!/^Bearer [^\s]+$/.test(user))
      throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    const outbound=new grpc.Metadata();
    outbound.set('x-correlation-id',randomUUID());
    outbound.set('x-cab-user-authorization',user);
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.definition,'VerifyUserIdentity',
      {allowed_roles:['CUSTOMER','DRIVER','OPERATOR']},outbound,900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if (code===grpc.status.UNAUTHENTICATED)
        throw denied(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if (code===grpc.status.PERMISSION_DENIED)
        throw denied(grpc.status.PERMISSION_DENIED,'FORBIDDEN','END_USER');
      throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if (typeof value.account_id!=='string'||!identifier.test(value.account_id)||
        !['CUSTOMER','DRIVER','OPERATOR'].includes(String(value.role)))
      throw denied(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return value.account_id;
  }
  private mac(value:string):Buffer {
    return createHmac('sha256',this.cursorKey).update(value).digest();
  }
  private encode(accountId:string,isRead:boolean|null,limit:number,row:Notice):string {
    const value=Buffer.from(JSON.stringify({accountId,isRead,limit,
      publishedAt:row.publishedAt.toISOString(),id:row._id,expiresAt:Date.now()+3600000}))
      .toString('base64url');
    return value+'.'+this.mac(value).toString('base64url');
  }
  private decode(cursor:string,accountId:string,isRead:boolean|null,limit:number):
    {publishedAt:Date;id:string} {
    const [value,signature,...extra]=cursor.split('.');
    if (!value||!signature||extra.length||cursor.length>2048)
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR','END_USER');
    const actual=Buffer.from(signature,'base64url'),expected=this.mac(value);
    if (actual.length!==expected.length||!timingSafeEqual(actual,expected))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR','END_USER');
    let data:Data;
    try {data=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as Data;}
    catch {throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR','END_USER');}
    if (data.accountId!==accountId||data.isRead!==isRead||data.limit!==limit||
        typeof data.expiresAt!=='number'||data.expiresAt<Date.now()||
        typeof data.publishedAt!=='string'||!Number.isFinite(Date.parse(data.publishedAt))||
        typeof data.id!=='string'||!identifier.test(data.id))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR','END_USER');
    return {publishedAt:new Date(data.publishedAt),id:data.id};
  }
  private dto(row:Notice):Data {
    return {notification_id:row._id,event_id:row.eventId,
      recipient_account_id:row.recipientAccountId,event_type:row.eventType,
      reference_type:row.referenceType,reference_id:row.referenceId,
      channel:row.channel,delivery_status:row.deliveryStatus,title:row.title,
      message:row.message,is_read:row.isRead,...(row.readAt?{read_at:ts(row.readAt)}:{}),
      occurred_at:ts(row.occurredAt),created_at:ts(row.createdAt),
      published_at:ts(row.publishedAt)};
  }
  async list(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const accountId=await this.principal(metadata);
    if (!record(request)) throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR','END_USER');
    const limit=request.limit===undefined?20:request.limit;
    const isRead=Object.hasOwn(request,'is_read')?request.is_read:null;
    const cursor=request.cursor;
    if (!Number.isInteger(limit)||Number(limit)<1||Number(limit)>100||
        (isRead!==null&&typeof isRead!=='boolean')||
        (cursor!==undefined&&(typeof cursor!=='string'||cursor.length<1||cursor.length>2048)))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR','END_USER');
    const match:Data={recipientAccountId:accountId,channel:'IN_APP',deliveryStatus:'SENT',
      ...(isRead!==null?{isRead}:{})};
    if (typeof cursor==='string') {
      const point=this.decode(cursor,accountId,isRead,Number(limit));
      match.$or=[{publishedAt:{$lt:point.publishedAt}},
        {publishedAt:point.publishedAt,_id:{$lt:point.id}}];
    }
    const rows=await this.store.notifications.find(match).sort({publishedAt:-1,_id:-1})
      .limit(Number(limit)+1).toArray();
    const page=rows.slice(0,Number(limit));
    return {items:page.map(row=>this.dto(row)),
      ...(rows.length>Number(limit)&&page.at(-1)?
        {next_cursor:this.encode(accountId,isRead,Number(limit),page.at(-1)!)}:{})};
  }
  async read(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const accountId=await this.principal(metadata);
    const id=record(request)?request.notification_id:undefined;
    if (typeof id!=='string'||!identifier.test(id))
      throw denied(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR','END_USER');
    const filter={_id:id,recipientAccountId:accountId,channel:'IN_APP' as const,
      deliveryStatus:'SENT' as const};
    const updated=await this.store.notifications.findOneAndUpdate({...filter,isRead:false},
      {$set:{isRead:true,readAt:new Date()}},{returnDocument:'after'});
    const row=updated??await this.store.notifications.findOne(filter);
    if (!row) throw denied(grpc.status.NOT_FOUND,'NOTIFICATION_NOT_FOUND','END_USER');
    return this.dto(row);
  }
}
