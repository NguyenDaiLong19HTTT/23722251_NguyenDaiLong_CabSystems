import {readFileSync} from 'node:fs';
import {markWorkerHealthy} from '@cab/grpc-transport';
import amqp from 'amqplib';
import type {ChannelModel,ConfirmChannel} from 'amqplib';
import type pg from 'pg';

type EventRow={event_id:string;booking_id:string;aggregate_version:string;
  event_type:string;recipient_account_id:string;safe_payload:Record<string,unknown>;
  created_at:Date;attempts:number;trip_id:string|null};
export class BookingNotificationPublisher {
  private timer?:ReturnType<typeof setTimeout>;
  private connection?:ChannelModel;
  private channel?:ConfirmChannel;
  private stopped=false;
  constructor(private readonly db:pg.Pool) {}
  start():void {this.stopped=false;this.schedule(0);}
  private schedule(ms:number):void {if(!this.stopped) this.timer=setTimeout(()=>void this.tick(),ms);}
  private async connect():Promise<ConfirmChannel> {
    if(this.channel) return this.channel;
    const url=process.env.CAB_BOOKING_AMQPS_URL,ca=process.env.CAB_RABBIT_CA_FILE;
    if(!url||!ca) throw new Error('Booking broker configuration missing');
    const connection=await amqp.connect(url,{ca:readFileSync(ca),
      servername:process.env.CAB_RABBIT_TLS_SERVER_NAME??'rabbitmq',
      rejectUnauthorized:true,timeout:4000});
    const channel=await connection.createConfirmChannel();
    connection.on('error',()=>{this.connection=undefined;this.channel=undefined;});
    connection.on('close',()=>{this.connection=undefined;this.channel=undefined;});
    this.connection=connection;this.channel=channel;return channel;
  }
  private async claim():Promise<EventRow|undefined> {
    const result=await this.db.query<EventRow>(`WITH candidate AS (
      SELECT event_id FROM booking_outbox WHERE published_at IS NULL
        AND next_attempt_at<=now() AND (claim_until IS NULL OR claim_until<now())
      ORDER BY created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE booking_outbox o SET claim_until=now()+interval '20 seconds'
      FROM candidate c WHERE o.event_id=c.event_id RETURNING o.*
    ) SELECT c.event_id,c.booking_id,c.aggregate_version,c.event_type,
      c.recipient_account_id,c.safe_payload,c.created_at,c.attempts,b.trip_id
      FROM claimed c JOIN booking b ON b.booking_id=c.booking_id`);
    return result.rows[0];
  }
  private body(row:EventRow):Buffer {
    if(!['BOOKING_RECEIVED','BOOKING_CANCELLED','DRIVER_ASSIGNED','NO_DRIVER_FOUND',
        'TRIP_REQUEST_RECEIVED'].includes(row.event_type))
      throw new Error('Invalid Booking event');
    const snapshot=row.event_type==='TRIP_REQUEST_RECEIVED'
      ?{expiresAt:row.safe_payload.expiresAt}:row.event_type==='BOOKING_CANCELLED'
        ?{reasonCode:'OTHER',reasonText:row.safe_payload.reasonText}:{};
    const version=Number(row.aggregate_version);
    if(!Number.isSafeInteger(version)||version<1)
      throw new Error('Invalid Booking event version');
    const referenceId=row.event_type==='DRIVER_ASSIGNED'?row.trip_id:
      row.event_type==='TRIP_REQUEST_RECEIVED'?row.safe_payload.tripRequestId:row.booking_id;
    if(!referenceId) throw new Error('Booking event reference unavailable');
    const offerEvent=row.event_type==='TRIP_REQUEST_RECEIVED';
    const event={schemaVersion:2,eventId:row.event_id,source:'BOOKING_SERVICE',
      eventType:row.event_type,aggregateType:offerEvent?'TRIP_REQUEST':'BOOKING',
      aggregateId:offerEvent?referenceId:row.booking_id,
      aggregateVersion:version,referenceType:row.event_type==='DRIVER_ASSIGNED'?'TRIP':
        row.event_type==='TRIP_REQUEST_RECEIVED'?'TRIP_REQUEST':'BOOKING',
      referenceId,recipientAccountIds:[row.recipient_account_id],snapshot,
      occurredAt:row.created_at.toISOString(),correlationId:row.booking_id};
    const bytes=Buffer.from(JSON.stringify(event),'utf8');
    if(bytes.length>65536) throw new Error('Booking event too large');return bytes;
  }
  private async publish(row:EventRow):Promise<void> {
    const channel=await this.connect(),body=this.body(row);let returned=false;
    const onReturn=(message:amqp.Message)=>{if(message.properties.messageId===row.event_id) returned=true;};
    channel.on('return',onReturn);
    try {await new Promise<void>((resolve,reject)=>channel.publish('cab.booking.events',
      `notification.v2.${row.event_type}`,body,{mandatory:true,persistent:true,
        contentType:'application/json',contentEncoding:'utf-8',messageId:row.event_id,
        type:row.event_type,correlationId:row.booking_id,headers:{'cab-schema-version':2}},
      error=>error?reject(error):resolve()));
      if(returned) throw new Error('Unroutable Booking event');
      await this.db.query(`UPDATE booking_outbox SET published_at=now(),claim_until=NULL
        WHERE event_id=$1 AND published_at IS NULL`,[row.event_id]);
    } finally {channel.off('return',onReturn);}
  }
  private async tick():Promise<void> {
    let row:EventRow|undefined;
    try {row=await this.claim();if(row) await this.publish(row);
      markWorkerHealthy('booking','booking-outbox');this.schedule(row?0:1000);}
    catch {if(row) await this.db.query(`UPDATE booking_outbox SET attempts=attempts+1,
        claim_until=NULL,next_attempt_at=now()+interval '5 seconds'
        WHERE event_id=$1 AND published_at IS NULL`,[row.event_id]).catch(()=>undefined);
      await this.channel?.close().catch(()=>undefined);
      await this.connection?.close().catch(()=>undefined);
      this.channel=undefined;this.connection=undefined;this.schedule(2000);}
  }
  async close():Promise<void> {this.stopped=true;if(this.timer) clearTimeout(this.timer);
    await this.channel?.close().catch(()=>undefined);await this.connection?.close().catch(()=>undefined);
    this.channel=undefined;this.connection=undefined;}
}
