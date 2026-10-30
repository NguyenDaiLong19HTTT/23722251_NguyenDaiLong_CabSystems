import {readFileSync} from 'node:fs';
import {markWorkerHealthy} from '@cab/grpc-transport';
import amqp from 'amqplib';
import type {ChannelModel,ConfirmChannel} from 'amqplib';
import type pg from 'pg';

type EventRow={event_id:string;payment_id:string;aggregate_version:string;
  event_type:string;safe_payload:{attemptId:string;amount?:string;currency?:string};
  created_at:Date;attempts:number;customer_account_id:string;driver_account_id:string};
const backoff=(attempts:number)=>Math.min(60000,1000*2**Math.min(attempts,6));

export class PaymentNotificationPublisher {
  private timer?:ReturnType<typeof setTimeout>;
  private connection?:ChannelModel;
  private channel?:ConfirmChannel;
  private stopped=false;
  constructor(private readonly db:pg.Pool) {}
  start():void {this.stopped=false;this.schedule(0);}
  private schedule(ms:number):void {
    if (!this.stopped) this.timer=setTimeout(()=>void this.tick(),ms);
  }
  private async connect():Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    const url=process.env.CAB_PAYMENT_AMQPS_URL;
    const caFile=process.env.CAB_RABBIT_CA_FILE;
    if (!url||!caFile) throw new Error('Payment broker configuration missing');
    const connection=await amqp.connect(url,{ca:readFileSync(caFile),
      servername:process.env.CAB_RABBIT_TLS_SERVER_NAME??'rabbitmq',
      rejectUnauthorized:true,timeout:4000});
    const channel=await connection.createConfirmChannel();
    connection.on('error',()=>{this.channel=undefined;this.connection=undefined;});
    connection.on('close',()=>{this.channel=undefined;this.connection=undefined;});
    this.connection=connection;this.channel=channel;
    return channel;
  }
  private async claim():Promise<EventRow|undefined> {
    const result=await this.db.query<EventRow>(`WITH candidate AS (
      SELECT event_id FROM payment_outbox WHERE published_at IS NULL
        AND next_attempt_at<=now() AND (claim_until IS NULL OR claim_until<now())
      ORDER BY created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE payment_outbox o SET claim_until=now()+interval '20 seconds'
      FROM candidate c WHERE o.event_id=c.event_id RETURNING o.*
    ) SELECT c.event_id,c.payment_id,c.aggregate_version,c.event_type,c.safe_payload,
      c.created_at,c.attempts,p.customer_account_id,p.driver_account_id
      FROM claimed c JOIN payment p ON p.payment_id=c.payment_id`);
    return result.rows[0];
  }
  private body(row:EventRow):Buffer {
    if (!['PAYMENT_SUCCESS','PAYMENT_FAILED','PAYMENT_REVIEW_REQUIRED'].includes(row.event_type)||
        typeof row.safe_payload.attemptId!=='string')
      throw new Error('Invalid Payment event');
    const snapshot=row.event_type==='PAYMENT_SUCCESS'
      ?{paymentAttemptId:row.safe_payload.attemptId,
        amount:Number(row.safe_payload.amount),currency:row.safe_payload.currency}
      :row.event_type==='PAYMENT_FAILED'
        ?{paymentAttemptId:row.safe_payload.attemptId}:{};
    if (row.event_type==='PAYMENT_SUCCESS'&&
        (!Number.isSafeInteger(snapshot.amount)||snapshot.currency!=='VND'))
      throw new Error('Invalid Payment event amount');
    const version=Number(row.aggregate_version);
    if (!Number.isSafeInteger(version)) throw new Error('Invalid Payment event version');
    const event={schemaVersion:2,eventId:row.event_id,source:'PAYMENT_SERVICE',
      eventType:row.event_type,aggregateType:'PAYMENT',aggregateId:row.payment_id,
      aggregateVersion:version,referenceType:'PAYMENT',referenceId:row.payment_id,
      recipientAccountIds:row.event_type==='PAYMENT_SUCCESS'
        ?[row.customer_account_id,row.driver_account_id]:[row.customer_account_id],
      snapshot,occurredAt:row.created_at.toISOString(),correlationId:row.payment_id};
    const bytes=Buffer.from(JSON.stringify(event),'utf8');
    if (bytes.length>65536) throw new Error('Payment event too large');
    return bytes;
  }
  private async publish(row:EventRow):Promise<void> {
    const channel=await this.connect(),body=this.body(row);
    let returned=false;
    const onReturn=(message:amqp.Message)=>{
      if (message.properties.messageId===row.event_id) returned=true;
    };
    channel.on('return',onReturn);
    try {
      await new Promise<void>((resolve,reject)=>channel.publish('cab.payment.events',
        `notification.v2.${row.event_type}`,body,{mandatory:true,persistent:true,
          contentType:'application/json',contentEncoding:'utf-8',messageId:row.event_id,
          type:row.event_type,correlationId:row.payment_id,
          headers:{'cab-schema-version':2}},error=>error?reject(error):resolve()));
      if (returned) throw new Error('Unroutable Payment event');
      await this.db.query(`UPDATE payment_outbox SET published_at=now(),claim_until=NULL
        WHERE event_id=$1 AND published_at IS NULL`,[row.event_id]);
    } finally {channel.off('return',onReturn);}
  }
  private async tick():Promise<void> {
    let row:EventRow|undefined;
    try {
      row=await this.claim();if (row) await this.publish(row);
      markWorkerHealthy('payment','payment-outbox');
      this.schedule(row?0:1000);
    } catch {
      if (row) await this.db.query(`UPDATE payment_outbox SET attempts=attempts+1,
        claim_until=NULL,next_attempt_at=now()+($2::integer*interval '1 millisecond')
        WHERE event_id=$1 AND published_at IS NULL`,[
        row.event_id,backoff(row.attempts+1)]).catch(()=>undefined);
      await this.channel?.close().catch(()=>undefined);
      await this.connection?.close().catch(()=>undefined);
      this.channel=undefined;this.connection=undefined;this.schedule(2000);
    }
  }
  async close():Promise<void> {
    this.stopped=true;if (this.timer) clearTimeout(this.timer);
    await this.channel?.close().catch(()=>undefined);
    await this.connection?.close().catch(()=>undefined);
    this.channel=undefined;this.connection=undefined;
  }
}
