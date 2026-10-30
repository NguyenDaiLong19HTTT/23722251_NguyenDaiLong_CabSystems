import {readFileSync} from 'node:fs';
import {markWorkerHealthy} from '@cab/grpc-transport';
import amqp from 'amqplib';
import type {ChannelModel,ConfirmChannel} from 'amqplib';
import type pg from 'pg';

type EventRow={event_id:string;trip_id:string;aggregate_version:string;event_type:string;
  safe_payload:Record<string,unknown>;created_at:Date;attempts:number;
  customer_account_id:string;driver_account_id:string};
export class TripNotificationPublisher {
  private timer?:ReturnType<typeof setTimeout>;
  private connection?:ChannelModel;
  private channel?:ConfirmChannel;
  private stopped=false;
  constructor(private readonly db:pg.Pool) {}
  start():void {this.stopped=false;this.schedule(0);}
  private schedule(ms:number):void {if(!this.stopped) this.timer=setTimeout(()=>void this.tick(),ms);}
  private async connect():Promise<ConfirmChannel> {
    if(this.channel) return this.channel;
    const url=process.env.CAB_TRIP_AMQPS_URL,ca=process.env.CAB_RABBIT_CA_FILE;
    if(!url||!ca) throw new Error('Trip broker configuration missing');
    const connection=await amqp.connect(url,{ca:readFileSync(ca),
      servername:process.env.CAB_RABBIT_TLS_SERVER_NAME??'rabbitmq',
      rejectUnauthorized:true,timeout:4000});
    const channel=await connection.createConfirmChannel();
    connection.on('error',()=>{this.channel=undefined;this.connection=undefined;});
    connection.on('close',()=>{this.channel=undefined;this.connection=undefined;});
    this.connection=connection;this.channel=channel;return channel;
  }
  private async claim():Promise<EventRow|undefined> {
    const found=await this.db.query<EventRow>(`WITH candidate AS (
      SELECT event_id FROM trip_outbox WHERE published_at IS NULL AND next_attempt_at<=now()
        AND (claim_until IS NULL OR claim_until<now())
      ORDER BY created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE trip_outbox o SET claim_until=now()+interval '20 seconds'
      FROM candidate c WHERE o.event_id=c.event_id RETURNING o.*
    ) SELECT c.event_id,c.trip_id,c.aggregate_version,c.event_type,c.safe_payload,
      c.created_at,c.attempts,t.customer_account_id,t.driver_account_id
      FROM claimed c JOIN trip t ON t.trip_id=c.trip_id`);
    return found.rows[0];
  }
  private body(row:EventRow):Buffer {
    const both=['TRIP_COMPLETED','TRIP_CANCELLED','TRIP_ERROR','TRIP_RECOVERED',
      'TRIP_CLOSED_ABNORMALLY'].includes(row.event_type);
    if(!['DRIVER_ARRIVED','TRIP_STARTED','TRIP_COMPLETED','TRIP_CANCELLED','TRIP_ERROR',
      'TRIP_RECOVERED','TRIP_CLOSED_ABNORMALLY']
        .includes(row.event_type)) throw new Error('Invalid Trip event');
    const snapshot=row.event_type==='TRIP_CANCELLED'
      ?{reasonCode:row.safe_payload.reasonCode,reasonText:row.safe_payload.reasonText}:{};
    if(row.event_type==='TRIP_CANCELLED'&&
        (typeof snapshot.reasonCode!=='string'||typeof snapshot.reasonText!=='string'))
      throw new Error('Invalid Trip cancellation event');
    const version=Number(row.aggregate_version);
    if(!Number.isSafeInteger(version)||version<1) throw new Error('Invalid Trip event version');
    const event={schemaVersion:2,eventId:row.event_id,source:'TRIP_SERVICE',
      eventType:row.event_type,aggregateType:'TRIP',aggregateId:row.trip_id,
      aggregateVersion:version,referenceType:'TRIP',referenceId:row.trip_id,
      recipientAccountIds:both?[row.customer_account_id,row.driver_account_id]:[
        row.customer_account_id],snapshot,occurredAt:row.created_at.toISOString(),
      correlationId:row.trip_id};
    const bytes=Buffer.from(JSON.stringify(event),'utf8');
    if(bytes.length>65536) throw new Error('Trip event too large');return bytes;
  }
  private async publish(row:EventRow):Promise<void> {
    const channel=await this.connect(),body=this.body(row);let returned=false;
    const onReturn=(message:amqp.Message)=>{if(message.properties.messageId===row.event_id) returned=true;};
    channel.on('return',onReturn);
    try {await new Promise<void>((resolve,reject)=>channel.publish('cab.trip.events',
      `notification.v2.${row.event_type}`,body,{mandatory:true,persistent:true,
        contentType:'application/json',contentEncoding:'utf-8',messageId:row.event_id,
        type:row.event_type,correlationId:row.trip_id,headers:{'cab-schema-version':2}},
      error=>error?reject(error):resolve()));
      if(returned) throw new Error('Unroutable Trip event');
      await this.db.query(`UPDATE trip_outbox SET published_at=now(),claim_until=NULL
        WHERE event_id=$1 AND published_at IS NULL`,[row.event_id]);
    } finally {channel.off('return',onReturn);}
  }
  private async tick():Promise<void> {
    let row:EventRow|undefined;
    try {row=await this.claim();if(row) await this.publish(row);
      markWorkerHealthy('trip','trip-outbox');this.schedule(row?0:1000);}
    catch {if(row) await this.db.query(`UPDATE trip_outbox SET attempts=attempts+1,
        claim_until=NULL,next_attempt_at=now()+interval '5 seconds'
        WHERE event_id=$1 AND published_at IS NULL`,[row.event_id]).catch(()=>undefined);
      await this.channel?.close().catch(()=>undefined);
      await this.connection?.close().catch(()=>undefined);
      this.channel=undefined;this.connection=undefined;this.schedule(2000);}
  }
  async close():Promise<void> {this.stopped=true;if(this.timer) clearTimeout(this.timer);
    await this.channel?.close().catch(()=>undefined);
    await this.connection?.close().catch(()=>undefined);
    this.channel=undefined;this.connection=undefined;}
}
