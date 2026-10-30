import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import type {ConsumeMessage} from 'amqplib';
import {parseDriverNotificationEvent,parseNotificationEvent} from '../services/notification-service/src/application/driver-event.js';

function fixture(type:'APPROVED'|'REJECTED'):Record<string,unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(
    `../contracts/events/examples/DRIVER_APPLICATION_${type}.json`,import.meta.url)),'utf8'));
}
function message(event:Record<string,unknown>,body=JSON.stringify(event)):ConsumeMessage {
  const exchanges:Record<string,string>={DRIVER_SERVICE:'cab.driver.events',
    BOOKING_SERVICE:'cab.booking.events',TRIP_SERVICE:'cab.trip.events',
    PAYMENT_SERVICE:'cab.payment.events'};
  return {content:Buffer.from(body),fields:{exchange:exchanges[String(event.source)],
    routingKey:`notification.v2.${event.eventType}`},properties:{
      contentType:'application/json',contentEncoding:'utf-8',deliveryMode:2,
      messageId:event.eventId,type:event.eventType,correlationId:event.correlationId,
      headers:{'cab-schema-version':2}}} as unknown as ConsumeMessage;
}

describe('Notification v2 Driver event contract',()=>{
  it('accepts both official opaque-ID fixtures',()=>{
    for(const type of ['APPROVED','REJECTED'] as const) {
      const event=fixture(type);
      expect(parseDriverNotificationEvent(message(event)).eventId).toBe(event.eventId);
    }
  });
  it('rejects source/routing and property spoofing',()=>{
    const event=fixture('APPROVED');
    const wrongRoute=message(event);
    wrongRoute.fields.routingKey='notification.v2.DRIVER_APPLICATION_REJECTED';
    expect(()=>parseDriverNotificationEvent(wrongRoute)).toThrow();
    const wrongId=message(event);
    wrongId.properties.messageId='different';
    expect(()=>parseDriverNotificationEvent(wrongId)).toThrow();
  });
  it('rejects duplicate JSON keys before trusting recipient identity',()=>{
    const event=fixture('APPROVED');
    const body=JSON.stringify(event).replace('"recipientAccountIds":["ACC001"]',
      '"recipientAccountIds":["ACC001"],"recipientAccountIds":["OTHER"]');
    expect(()=>parseDriverNotificationEvent(message(event,body))).toThrow('EVENT_DUPLICATE_KEY');
  });
  it('rejects missing rejection reason and identifiers outside API06 bounds',()=>{
    const rejected=fixture('REJECTED');
    rejected.snapshot={};
    expect(()=>parseDriverNotificationEvent(message(rejected))).toThrow();
    const event=fixture('APPROVED');
    event.eventId='e'.repeat(201);
    expect(()=>parseDriverNotificationEvent(message(event))).toThrow();
    event.eventId='event-id';event.recipientAccountIds=['a'.repeat(129)];
    expect(()=>parseDriverNotificationEvent(message(event))).toThrow();
  });
});

describe('Notification v2 Booking/Trip/Payment event contract',()=>{
  it('accepts the official examples with exact source and routing',()=>{
    for(const type of ['BOOKING_RECEIVED','TRIP_REQUEST_RECEIVED','TRIP_COMPLETED',
      'TRIP_ERROR','PAYMENT_SUCCESS','PAYMENT_FAILED']) {
      const event=JSON.parse(readFileSync(fileURLToPath(new URL(
        `../contracts/events/examples/${type}.json`,import.meta.url)),'utf8'));
      expect(parseNotificationEvent(message(event)).eventType).toBe(type);
    }
  });
  it('rejects exchange spoofing, invalid recipients, and missing payment evidence',()=>{
    const event=JSON.parse(readFileSync(fileURLToPath(new URL(
      '../contracts/events/examples/PAYMENT_SUCCESS.json',import.meta.url)),'utf8'));
    const wrongExchange=message(event);wrongExchange.fields.exchange='cab.driver.events';
    expect(()=>parseNotificationEvent(wrongExchange)).toThrow();
    const duplicate={...event,recipientAccountIds:[event.recipientAccountIds[0],
      event.recipientAccountIds[0]]};
    expect(()=>parseNotificationEvent(message(duplicate))).toThrow();
    const missing={...event,snapshot:{paymentAttemptId:event.snapshot.paymentAttemptId}};
    expect(()=>parseNotificationEvent(message(missing))).toThrow();
  });
});
