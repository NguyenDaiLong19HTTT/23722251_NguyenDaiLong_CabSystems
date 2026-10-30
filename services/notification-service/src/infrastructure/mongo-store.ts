import {Injectable,OnModuleDestroy,OnModuleInit} from '@nestjs/common';
import {MongoClient,type Collection} from 'mongodb';

export type NotificationEvent={schemaVersion:2;eventId:string;source:string;
  eventType:string;aggregateType:string;aggregateId:string;aggregateVersion:number;
  referenceType:string;referenceId:string;recipientAccountIds:string[];
  snapshot:{reasonCode?:string;reasonText?:string;expiresAt?:string;
    paymentAttemptId?:string;amount?:number;currency?:string};
  occurredAt:string;correlationId:string};
export type Inbox={_id:string;digest:string;event:NotificationEvent;status:'PENDING'|'DONE'|'DEAD';
  attempts:number;nextAttemptAt:Date;createdAt:Date};
export type Notice={_id:string;eventId:string;recipientAccountId:string;eventType:string;
  referenceType:string;referenceId:string;channel:'IN_APP';deliveryStatus:'SENT';
  title:string;message:string;isRead:boolean;readAt?:Date;occurredAt:Date;
  createdAt:Date;publishedAt:Date};
export type Quarantine={_id:string;exchange:string;routingKey:string;reason:string;
  properties:{messageId?:string;type?:string;contentType?:string};
  ciphertext:Buffer;nonce:Buffer;tag:Buffer;createdAt:Date;
  publishedAt?:Date;nextAttemptAt:Date;attempts:number};

@Injectable()
export class NotificationMongoStore implements OnModuleInit,OnModuleDestroy {
  private client?:MongoClient;
  private dbName='cab_notification';
  get inbox():Collection<Inbox> {
    if (!this.client) throw new Error('Notification MongoDB not connected');
    return this.client.db(this.dbName).collection<Inbox>('inbox_jobs');
  }
  get notifications():Collection<Notice> {
    if (!this.client) throw new Error('Notification MongoDB not connected');
    return this.client.db(this.dbName).collection<Notice>('notifications');
  }
  get quarantine():Collection<Quarantine> {
    if (!this.client) throw new Error('Notification MongoDB not connected');
    return this.client.db(this.dbName).collection<Quarantine>('quarantine_outbox');
  }
  async onModuleInit():Promise<void> {
    const source=process.env.CAB_NOTIFICATION_MONGO_URL;
    let url:URL;
    try {url=new URL(source??'');} catch {throw new Error('Notification MongoDB configuration invalid');}
    if (url.protocol!=='mongodb:'||url.username!=='notification_runtime'||
        url.pathname!=='/cab_notification'||!url.password)
      throw new Error('Notification MongoDB configuration invalid');
    const client=new MongoClient(source!,{maxPoolSize:5,minPoolSize:0,
      serverSelectionTimeoutMS:3000,connectTimeoutMS:3000});
    try {
      await client.connect();
      await client.db(this.dbName).command({ping:1});
      this.client=client;
      await this.notifications.createIndex({eventId:1,recipientAccountId:1,channel:1},
        {unique:true,name:'event_recipient_channel_unique'});
      await this.notifications.createIndex({recipientAccountId:1,isRead:1,
        publishedAt:-1,_id:-1},{name:'own_read_published_order'});
      await this.inbox.createIndex({status:1,nextAttemptAt:1,createdAt:1},
        {name:'pending_jobs'});
      await this.quarantine.createIndex({publishedAt:1,nextAttemptAt:1},
        {name:'pending_dead_letters'});
    } catch {
      await client.close().catch(()=>undefined);
      this.client=undefined;
      throw new Error('Notification MongoDB runtime connection failed');
    }
  }
  async onModuleDestroy():Promise<void> {
    const client=this.client;this.client=undefined;
    await client?.close();
  }
}
