import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import amqp from 'amqplib';
import {markWorkerHealthy} from '@cab/grpc-transport';
import type {Channel,ChannelModel,ConfirmChannel,ConsumeMessage} from 'amqplib';
import {parseNotificationEvent} from './driver-event.js';
import {NotificationMongoStore,type NotificationEvent,type Inbox,type Quarantine} from '../infrastructure/mongo-store.js';

const retry=[1000,5000,30000,120000,600000];
const jitter=(ms:number)=>Math.round(ms*(0.8+Math.random()*0.4));
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const text=(event:NotificationEvent):{title:string;message:string}=>{
  switch(event.eventType) {
    case 'BOOKING_RECEIVED':return {title:'Đã nhận yêu cầu đặt xe',
      message:'Yêu cầu đặt xe đã được ghi nhận. Hãy xem trạng thái hiện tại.'};
    case 'BOOKING_CANCELLED':return {title:'Yêu cầu đặt xe đã hủy',
      message:'Yêu cầu đặt xe đã hủy. Hãy xem chi tiết hiện tại.'};
    case 'NO_DRIVER_FOUND':return {title:'Chưa tìm được tài xế',
      message:'Không tìm được tài xế phù hợp cho yêu cầu này.'};
    case 'DRIVER_ASSIGNED':return {title:'Đã phân công tài xế',
      message:'Chuyến đã có tài xế. Hãy xem chi tiết chuyến.'};
    case 'TRIP_REQUEST_RECEIVED':return {title:'Có đề nghị nhận chuyến',
      message:'Hãy xem đề nghị và thời hạn hiện tại trước khi thao tác.'};
    case 'DRIVER_ARRIVED':return {title:'Tài xế đã đến điểm đón',
      message:'Tài xế đã đến điểm đón của chuyến.'};
    case 'TRIP_STARTED':return {title:'Chuyến đã bắt đầu',
      message:'Chuyến đang được thực hiện.'};
    case 'TRIP_COMPLETED':return {title:'Chuyến đã hoàn thành',
      message:'Chuyến đã hoàn thành. Thanh toán có trạng thái riêng.'};
    case 'TRIP_CANCELLED':return {title:'Chuyến đã hủy',
      message:'Chuyến đã hủy. Hãy xem chi tiết chuyến.'};
    case 'TRIP_ERROR':return {title:'Chuyến cần hỗ trợ',
      message:'Chuyến phát sinh sự cố và cần vận hành xử lý.'};
    case 'TRIP_RECOVERED':return {title:'Chuyến đã được khôi phục',
      message:'Vui lòng xem trạng thái chuyến mới nhất.'};
    case 'TRIP_CLOSED_ABNORMALLY':return {title:'Chuyến đã đóng bất thường',
      message:'Vui lòng xem trạng thái chuyến và thanh toán riêng.'};
    case 'PAYMENT_SUCCESS':return {title:'Đã ghi nhận thanh toán',
      message:`Đã ghi nhận ${event.snapshot.amount} VND. Xem chi tiết thanh toán.`};
    case 'PAYMENT_FAILED':return {title:'Thanh toán chưa thành công',
      message:'Xem trạng thái thanh toán hiện tại trước khi thử lại.'};
    case 'PAYMENT_UNKNOWN':return {title:'Kết quả thanh toán chưa rõ',
      message:'Thanh toán cần đối soát; chưa xác nhận thành công hoặc thất bại.'};
    case 'PAYMENT_REVIEW_REQUIRED':return {title:'Thanh toán cần rà soát',
      message:'Cần xử lý thủ công; chưa xác nhận hoàn tiền.'};
    case 'DRIVER_APPLICATION_SUBMITTED':return {
      title:'Đã tiếp nhận hồ sơ tài xế',message:'Hồ sơ của bạn đang chờ xét duyệt.'};
    case 'DRIVER_APPLICATION_APPROVED':return {
      title:'Hồ sơ tài xế đã được duyệt',
      message:'Hồ sơ đã được duyệt. Hãy cập nhật vị trí và bật nhận chuyến khi đủ điều kiện.'};
    case 'DRIVER_APPLICATION_REJECTED':return {
      title:'Hồ sơ tài xế bị từ chối',
      message:`Hồ sơ bị từ chối. Lý do: ${event.snapshot.reasonText}`};
  }
  throw new Error('Unsupported notification event');
};

export class NotificationDelivery {
  private connection?:ChannelModel;
  private consumer?:Channel;
  private dead?:ConfirmChannel;
  private timer?:ReturnType<typeof setTimeout>;
  private reconnect?:ReturnType<typeof setTimeout>;
  private stopped=false;
  private readonly key:Buffer;
  constructor(private readonly store:NotificationMongoStore) {
    const path=process.env.CAB_NOTIFICATION_DLQ_KEY_FILE;
    if (!path) throw new Error('Notification DLQ key missing');
    this.key=Buffer.from(readFileSync(path,'utf8').trim(),'base64url');
    if (this.key.length!==32) throw new Error('Notification DLQ key invalid');
  }
  async start():Promise<void> {this.stopped=false;await this.connect();this.schedule(0);}
  private scheduleReconnect():void {
    if (this.stopped||this.reconnect) return;
    this.reconnect=setTimeout(()=>{
      this.reconnect=undefined;
      void this.connect().catch(()=>this.scheduleReconnect());
    },2000);
  }
  private async connect():Promise<void> {
    const url=process.env.CAB_NOTIFICATION_AMQPS_URL,caFile=process.env.CAB_RABBIT_CA_FILE;
    if (!url||!caFile) throw new Error('Notification AMQPS configuration missing');
    const connection=await amqp.connect(url,{ca:readFileSync(caFile),
      servername:process.env.CAB_RABBIT_TLS_SERVER_NAME??'localhost',
      rejectUnauthorized:true,timeout:4000});
    try {
      const consumer=await connection.createChannel();
      const dead=await connection.createConfirmChannel();
      await consumer.prefetch(20);
      await consumer.consume('cab.notification.v2',message=>{
        if (message) void this.receive(message,consumer);
      },{noAck:false});
      this.connection=connection;this.consumer=consumer;this.dead=dead;
      connection.on('error',()=>undefined);
      connection.on('close',()=>{
        this.connection=undefined;this.consumer=undefined;this.dead=undefined;
        this.scheduleReconnect();
      });
    } catch(error) {await connection.close().catch(()=>undefined);throw error;}
  }
  private async quarantine(message:ConsumeMessage,reason:string):Promise<void> {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    const ciphertext=Buffer.concat([cipher.update(message.content),cipher.final()]);
    const id=digest(Buffer.concat([Buffer.from(message.fields.exchange+':'+message.fields.routingKey+':'),
      message.content]));
    const now=new Date();
    await this.store.quarantine.updateOne({_id:id},{$setOnInsert:{_id:id,
      exchange:message.fields.exchange,routingKey:message.fields.routingKey,reason,
      properties:{messageId:message.properties.messageId,type:message.properties.type,
        contentType:message.properties.contentType},ciphertext,nonce,tag:cipher.getAuthTag(),
      createdAt:now,nextAttemptAt:now,attempts:0}},{upsert:true});
  }
  private async receive(message:ConsumeMessage,channel:Channel):Promise<void> {
    let event:NotificationEvent;
    try {event=parseNotificationEvent(message);}
    catch(error) {
      try {
        await this.quarantine(message,error instanceof Error&&/^[A-Z_]+$/.test(error.message)
          ?error.message:'EVENT_PARSE_INVALID');
        channel.ack(message);
      } catch {await this.connection?.close().catch(()=>undefined);}
      return;
    }
    try {
      const hash=digest(message.content),now=new Date();
      await this.store.inbox.updateOne({_id:event.eventId},{$setOnInsert:{_id:event.eventId,
        digest:hash,event,status:'PENDING',attempts:0,nextAttemptAt:now,createdAt:now}},
      {upsert:true});
      const existing=await this.store.inbox.findOne({_id:event.eventId},{projection:{digest:1}});
      if (existing?.digest!==hash) {
        await this.quarantine(message,'EVENT_ID_PAYLOAD_CONFLICT');
      }
      channel.ack(message);
    } catch {await this.connection?.close().catch(()=>undefined);}
  }
  private schedule(ms:number):void {
    if (!this.stopped) this.timer=setTimeout(()=>void this.poll(),ms);
  }
  private async materialize(job:Inbox):Promise<void> {
    const event=job.event,now=new Date(),content=text(event);
    if (content.message.length>2000) throw new Error('Notification content exceeds API limit');
    for(const recipient of event.recipientAccountIds)
      await this.store.notifications.updateOne({eventId:event.eventId,
        recipientAccountId:recipient,channel:'IN_APP'},
      {$setOnInsert:{_id:randomUUID(),eventId:event.eventId,
        recipientAccountId:recipient,eventType:event.eventType,
        referenceType:event.referenceType,referenceId:event.referenceId,channel:'IN_APP',
        deliveryStatus:'SENT',title:content.title,message:content.message,isRead:false,
        occurredAt:new Date(event.occurredAt),createdAt:now,publishedAt:now}},{upsert:true});
    await this.store.inbox.updateOne({_id:job._id,status:'PENDING'},{$set:{status:'DONE'}});
  }
  private async deadLetter(item:Quarantine):Promise<void> {
    const channel=this.dead;
    if (!channel) return;
    // MongoDB deserializes stored Buffer fields as BSON Binary values.
    const bytes=(value:Buffer|{buffer:Uint8Array})=>
      Buffer.isBuffer(value)?value:Buffer.from(value.buffer);
    const nonce=bytes(item.nonce),tag=bytes(item.tag),ciphertext=bytes(item.ciphertext);
    const raw=createDecipheriv('aes-256-gcm',this.key,nonce);
    raw.setAuthTag(tag);
    // Check the encrypted source is authentic before publishing the encrypted wrapper.
    Buffer.concat([raw.update(ciphertext),raw.final()]);
    const body=Buffer.from(JSON.stringify({sourceExchange:item.exchange,
      sourceRoutingKey:item.routingKey,properties:item.properties,
      ciphertext:ciphertext.toString('base64'),nonce:nonce.toString('base64'),
      tag:tag.toString('base64'),reason:item.reason,failedAt:item.createdAt.toISOString()}));
    let returned=false;
    const onReturn=(message:amqp.Message)=>{
      if (message.properties.messageId===item._id) returned=true;
    };
    channel.on('return',onReturn);
    try {
      await new Promise<void>((resolve,reject)=>{
        channel.publish('cab.notification.dead','cab.notification.v2',body,
          {mandatory:true,persistent:true,contentType:'application/json',
            messageId:item._id},error=>error?reject(error):resolve());
      });
      if (returned) throw new Error('Dead letter unroutable');
      await this.store.quarantine.updateOne({_id:item._id,publishedAt:{$exists:false}},
        {$set:{publishedAt:new Date()}});
    } finally {channel.off('return',onReturn);}
  }
  private async poll():Promise<void> {
    try {
      const now=new Date();
      const job=await this.store.inbox.findOne({status:'PENDING',nextAttemptAt:{$lte:now}},
        {sort:{createdAt:1}});
      if (job) {
        try {await this.materialize(job);}
        catch {
          const attempts=job.attempts+1;
          if (attempts>5) {
            const content=Buffer.from(JSON.stringify(job.event));
            const exchange={BOOKING_SERVICE:'cab.booking.events',TRIP_SERVICE:'cab.trip.events',
              PAYMENT_SERVICE:'cab.payment.events',DRIVER_SERVICE:'cab.driver.events'}[
                job.event.source]??'unknown';
            const message={content,fields:{exchange,
              routingKey:`notification.v2.${job.event.eventType}`},
              properties:{messageId:job.event.eventId,type:job.event.eventType,
                contentType:'application/json'}} as ConsumeMessage;
            await this.quarantine(message,'DELIVERY_RETRIES_EXHAUSTED');
            await this.store.inbox.updateOne({_id:job._id,status:'PENDING'},
              {$set:{status:'DEAD',attempts}});
          } else await this.store.inbox.updateOne({_id:job._id,status:'PENDING'},
            {$set:{attempts,nextAttemptAt:new Date(Date.now()+jitter(retry[attempts-1]!))}});
        }
      }
      const letter=await this.store.quarantine.findOne({publishedAt:{$exists:false},
        nextAttemptAt:{$lte:new Date()}},{sort:{createdAt:1}});
      if (letter) {
        try {await this.deadLetter(letter);}
        catch {await this.store.quarantine.updateOne({_id:letter._id},
          {$set:{attempts:letter.attempts+1,
            nextAttemptAt:new Date(Date.now()+jitter(retry[Math.min(letter.attempts,4)]!))}});}
      }
      if (this.consumer) markWorkerHealthy('notification','notification-delivery');
      this.schedule(job||letter?100:1000);
    } catch {this.schedule(2000);}
  }
  async close():Promise<void> {
    this.stopped=true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconnect) clearTimeout(this.reconnect);
    await this.consumer?.close().catch(()=>undefined);
    await this.dead?.close().catch(()=>undefined);
    await this.connection?.close().catch(()=>undefined);
    this.consumer=undefined;this.dead=undefined;this.connection=undefined;
  }
}
