import {readFileSync} from 'node:fs';
import {markWorkerHealthy} from '@cab/grpc-transport';
import amqp from 'amqplib';
import type {ConfirmChannel,ChannelModel} from 'amqplib';
import type {PrismaClient} from './prisma/generated/client.js';

type Outbox={event_id:string;application_id:string;aggregate_version:bigint;
  event_type:string;created_at:Date;account_id:string;operation_id:string;
  rejection_reason:string|null;attempts:number};
const stamp=(date:Date)=>date.toISOString();
const delay=(attempts:number)=>Math.min(60000,1000*2**Math.min(attempts,6));

export class DriverNotificationPublisher {
  private timer?:ReturnType<typeof setTimeout>;
  private connection?:ChannelModel;
  private channel?:ConfirmChannel;
  private stopped=false;
  constructor(private readonly db:PrismaClient) {}
  start():void {this.stopped=false;this.schedule(0);}
  private schedule(ms:number):void {
    if (!this.stopped) this.timer=setTimeout(()=>void this.tick(),ms);
  }
  private async connect():Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    const url=process.env.CAB_DRIVER_AMQPS_URL;
    const caFile=process.env.CAB_RABBIT_CA_FILE;
    if (!url||!caFile) throw new Error('Driver broker configuration missing');
    const connection=await amqp.connect(url,{ca:readFileSync(caFile),
      servername:process.env.CAB_RABBIT_TLS_SERVER_NAME??'localhost',
      rejectUnauthorized:true,timeout:4000});
    const channel=await connection.createConfirmChannel();
    connection.on('error',()=>{this.channel=undefined;this.connection=undefined;});
    connection.on('close',()=>{this.channel=undefined;this.connection=undefined;});
    this.connection=connection;this.channel=channel;
    return channel;
  }
  private async claim():Promise<Outbox|undefined> {
    const rows=await this.db.$queryRaw<Outbox[]>`
      WITH candidate AS (
        SELECT event_id FROM driver_application_outbox
        WHERE published_at IS NULL AND next_attempt_at<=now()
          AND (claim_until IS NULL OR claim_until<now())
        ORDER BY created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE driver_application_outbox o SET claim_until=now()+interval '20 seconds'
        FROM candidate c WHERE o.event_id=c.event_id RETURNING o.*
      )
      SELECT c.event_id,c.application_id,c.aggregate_version,c.event_type,c.created_at,c.attempts,
        a.account_id,a.operation_id,a.rejection_reason
      FROM claimed c JOIN driver_application a ON a.application_id=c.application_id`;
    return rows[0];
  }
  private body(row:Outbox):Buffer {
    const snapshot=row.event_type==='DRIVER_APPLICATION_REJECTED'
      ?{reasonText:row.rejection_reason}:{};
    if (row.event_type==='DRIVER_APPLICATION_REJECTED'&&
        (typeof row.rejection_reason!=='string'||!row.rejection_reason))
      throw new Error('Rejected event missing committed reason');
    const event={schemaVersion:2,eventId:row.event_id,source:'DRIVER_SERVICE',
      eventType:row.event_type,aggregateType:'DRIVER_APPLICATION',
      aggregateId:row.application_id,aggregateVersion:Number(row.aggregate_version),
      referenceType:'DRIVER_APPLICATION',referenceId:row.application_id,
      recipientAccountIds:[row.account_id],snapshot,occurredAt:stamp(row.created_at),
      correlationId:row.operation_id};
    const bytes=Buffer.from(JSON.stringify(event),'utf8');
    if (!Number.isSafeInteger(event.aggregateVersion)||bytes.length>65536)
      throw new Error('Driver event outside contract limits');
    return bytes;
  }
  private async publish(row:Outbox):Promise<void> {
    const channel=await this.connect(),payload=this.body(row);
    let returned=false;
    const onReturn=(message:amqp.Message)=>{
      if (message.properties.messageId===row.event_id) returned=true;
    };
    channel.on('return',onReturn);
    try {
      await new Promise<void>((resolve,reject)=>{
        channel.publish('cab.driver.events',`notification.v2.${row.event_type}`,payload,
          {mandatory:true,persistent:true,contentType:'application/json',contentEncoding:'utf-8',
            messageId:row.event_id,type:row.event_type,correlationId:row.operation_id,
            headers:{'cab-schema-version':2}},error=>error?reject(error):resolve());
      });
      if (returned) throw new Error('Unroutable Driver event');
      await this.db.$executeRaw`UPDATE driver_application_outbox SET published_at=now(),
        claim_until=NULL WHERE event_id=${row.event_id}::uuid AND published_at IS NULL`;
    } finally {channel.off('return',onReturn);}
  }
  private async tick():Promise<void> {
    let row:Outbox|undefined;
    try {
      row=await this.claim();
      if (row) await this.publish(row);
      markWorkerHealthy('driver','driver-outbox');
      this.schedule(row?0:1000);
    } catch {
      if (row) await this.db.$executeRaw`UPDATE driver_application_outbox
        SET attempts=attempts+1,claim_until=NULL,
          next_attempt_at=now()+(${delay(row.attempts+1)}::integer*interval '1 millisecond')
        WHERE event_id=${row.event_id}::uuid AND published_at IS NULL`.catch(()=>undefined);
      await this.channel?.close().catch(()=>undefined);
      await this.connection?.close().catch(()=>undefined);
      this.channel=undefined;this.connection=undefined;
      this.schedule(2000);
    }
  }
  async close():Promise<void> {
    this.stopped=true;
    if (this.timer) clearTimeout(this.timer);
    await this.channel?.close().catch(()=>undefined);
    await this.connection?.close().catch(()=>undefined);
    this.channel=undefined;this.connection=undefined;
  }
}
