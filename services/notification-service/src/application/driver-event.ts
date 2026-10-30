import type {ConsumeMessage} from 'amqplib';
import type {NotificationEvent} from '../infrastructure/mongo-store.js';

const sized=(value:unknown,max:number):value is string=>
  typeof value==='string'&&value.length>=1&&value.length<=max;
const exact=(value:Record<string,unknown>,keys:string[])=>
  Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const record=(value:unknown):value is Record<string,unknown>=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
type Rule={exchange:string;source:string;aggregate:string;reference:string;
  recipients:1|2;snapshot:string[]};
const rules:Record<string,Rule>={
  BOOKING_RECEIVED:{exchange:'cab.booking.events',source:'BOOKING_SERVICE',aggregate:'BOOKING',reference:'BOOKING',recipients:1,snapshot:[]},
  BOOKING_CANCELLED:{exchange:'cab.booking.events',source:'BOOKING_SERVICE',aggregate:'BOOKING',reference:'BOOKING',recipients:1,snapshot:['reasonCode','reasonText']},
  DRIVER_ASSIGNED:{exchange:'cab.booking.events',source:'BOOKING_SERVICE',aggregate:'BOOKING',reference:'TRIP',recipients:1,snapshot:[]},
  NO_DRIVER_FOUND:{exchange:'cab.booking.events',source:'BOOKING_SERVICE',aggregate:'BOOKING',reference:'BOOKING',recipients:1,snapshot:[]},
  TRIP_REQUEST_RECEIVED:{exchange:'cab.booking.events',source:'BOOKING_SERVICE',aggregate:'TRIP_REQUEST',reference:'TRIP_REQUEST',recipients:1,snapshot:['expiresAt']},
  DRIVER_ARRIVED:{exchange:'cab.trip.events',source:'TRIP_SERVICE',aggregate:'TRIP',reference:'TRIP',recipients:1,snapshot:[]},
  TRIP_STARTED:{exchange:'cab.trip.events',source:'TRIP_SERVICE',aggregate:'TRIP',reference:'TRIP',recipients:1,snapshot:[]},
  TRIP_COMPLETED:{exchange:'cab.trip.events',source:'TRIP_SERVICE',aggregate:'TRIP',reference:'TRIP',recipients:2,snapshot:[]},
  TRIP_CANCELLED:{exchange:'cab.trip.events',source:'TRIP_SERVICE',aggregate:'TRIP',reference:'TRIP',recipients:2,snapshot:['reasonCode','reasonText']},
  TRIP_ERROR:{exchange:'cab.trip.events',source:'TRIP_SERVICE',aggregate:'TRIP',reference:'TRIP',recipients:2,snapshot:[]},
  TRIP_RECOVERED:{exchange:'cab.trip.events',source:'TRIP_SERVICE',aggregate:'TRIP',reference:'TRIP',recipients:2,snapshot:[]},
  TRIP_CLOSED_ABNORMALLY:{exchange:'cab.trip.events',source:'TRIP_SERVICE',aggregate:'TRIP',reference:'TRIP',recipients:2,snapshot:[]},
  PAYMENT_SUCCESS:{exchange:'cab.payment.events',source:'PAYMENT_SERVICE',aggregate:'PAYMENT',reference:'PAYMENT',recipients:2,snapshot:['paymentAttemptId','amount','currency']},
  PAYMENT_FAILED:{exchange:'cab.payment.events',source:'PAYMENT_SERVICE',aggregate:'PAYMENT',reference:'PAYMENT',recipients:1,snapshot:['paymentAttemptId']},
  PAYMENT_UNKNOWN:{exchange:'cab.payment.events',source:'PAYMENT_SERVICE',aggregate:'PAYMENT',reference:'PAYMENT',recipients:1,snapshot:[]},
  PAYMENT_REVIEW_REQUIRED:{exchange:'cab.payment.events',source:'PAYMENT_SERVICE',aggregate:'PAYMENT',reference:'PAYMENT',recipients:1,snapshot:[]},
  DRIVER_APPLICATION_SUBMITTED:{exchange:'cab.driver.events',source:'DRIVER_SERVICE',aggregate:'DRIVER_APPLICATION',reference:'DRIVER_APPLICATION',recipients:1,snapshot:[]},
  DRIVER_APPLICATION_APPROVED:{exchange:'cab.driver.events',source:'DRIVER_SERVICE',aggregate:'DRIVER_APPLICATION',reference:'DRIVER_APPLICATION',recipients:1,snapshot:[]},
  DRIVER_APPLICATION_REJECTED:{exchange:'cab.driver.events',source:'DRIVER_SERVICE',aggregate:'DRIVER_APPLICATION',reference:'DRIVER_APPLICATION',recipients:1,snapshot:['reasonText']},
};

// JSON.parse accepts duplicate object keys; reject those before interpreting identity or recipients.
function hasDuplicateKeys(source:string):boolean {
  const stack:Array<{kind:'object'|'array';keys:Set<string>;expectKey:boolean}>=[];
  for (let i=0;i<source.length;i++) {
    const char=source[i];
    if (char==='"') {
      const start=i;
      for (i++;i<source.length;i++) {
        if (source[i]==='\\') {i++;continue;}
        if (source[i]==='"') break;
      }
      const key=JSON.parse(source.slice(start,i+1)) as string;
      const current=stack.at(-1);
      if (current?.kind==='object'&&current.expectKey) {
        if (current.keys.has(key)) return true;
        current.keys.add(key);current.expectKey=false;
      }
    } else if (char==='{') stack.push({kind:'object',keys:new Set(),expectKey:true});
    else if (char==='[') stack.push({kind:'array',keys:new Set(),expectKey:false});
    else if (char==='}'||char===']') stack.pop();
    else if (char===',') {
      const current=stack.at(-1);
      if (current?.kind==='object') current.expectKey=true;
    }
  }
  return false;
}

export function parseNotificationEvent(message:ConsumeMessage):NotificationEvent {
  const props=message.properties;
  if (!message.fields.routingKey.startsWith('notification.v2.')||
      props.contentType!=='application/json'||props.contentEncoding!=='utf-8'||
      props.deliveryMode!==2||props.headers?.['cab-schema-version']!==2||
      message.content.length>65536)
    throw new Error('EVENT_PROPERTIES_INVALID');
  const source=new TextDecoder('utf-8',{fatal:true}).decode(message.content);
  if (hasDuplicateKeys(source)) throw new Error('EVENT_DUPLICATE_KEY');
  const raw:unknown=JSON.parse(source);
  const rule=record(raw)&&typeof raw.eventType==='string'?rules[raw.eventType]:undefined;
  if (!record(raw)||!exact(raw,['schemaVersion','eventId','source','eventType',
    'aggregateType','aggregateId','aggregateVersion','referenceType','referenceId',
    'recipientAccountIds','snapshot','occurredAt','correlationId'])||
    raw.schemaVersion!==2||!rule||message.fields.exchange!==rule.exchange||
    raw.source!==rule.source||raw.aggregateType!==rule.aggregate||
    raw.referenceType!==rule.reference||
    !sized(raw.eventId,200)||!sized(raw.aggregateId,128)||
    !sized(raw.referenceId,128)||!sized(raw.correlationId,200)||
    (rule.aggregate===rule.reference&&raw.aggregateId!==raw.referenceId)||
    !Number.isSafeInteger(raw.aggregateVersion)||Number(raw.aggregateVersion)<1||
    !Array.isArray(raw.recipientAccountIds)||
    raw.recipientAccountIds.length!==rule.recipients||
    raw.recipientAccountIds.some(value=>!sized(value,128))||
    new Set(raw.recipientAccountIds).size!==raw.recipientAccountIds.length||
    !record(raw.snapshot)||typeof raw.occurredAt!=='string'||
    !Number.isFinite(Date.parse(raw.occurredAt))||
    props.messageId!==raw.eventId||props.type!==raw.eventType||
    props.correlationId!==raw.correlationId||
    message.fields.routingKey!==`notification.v2.${raw.eventType}`)
    throw new Error('EVENT_SCHEMA_INVALID');
  if(!exact(raw.snapshot,rule.snapshot)) throw new Error('EVENT_SNAPSHOT_INVALID');
  if(rule.snapshot.includes('reasonText')&&
      (typeof raw.snapshot.reasonText!=='string'||
        !raw.snapshot.reasonText.trim()||raw.snapshot.reasonText.length>1000||
        (rule.snapshot.includes('reasonCode')&&
          !['CHANGE_OF_PLANS','VEHICLE_ISSUE','NO_SHOW','OTHER']
            .includes(String(raw.snapshot.reasonCode)))))
    throw new Error('EVENT_REASON_INVALID');
  if(rule.snapshot.includes('expiresAt')&&
      (typeof raw.snapshot.expiresAt!=='string'||
        !Number.isFinite(Date.parse(raw.snapshot.expiresAt))))
    throw new Error('EVENT_EXPIRY_INVALID');
  if(rule.snapshot.includes('paymentAttemptId')&&
      !sized(raw.snapshot.paymentAttemptId,128))
    throw new Error('EVENT_ATTEMPT_INVALID');
  if(rule.snapshot.includes('amount')&&
      (!Number.isSafeInteger(raw.snapshot.amount)||Number(raw.snapshot.amount)<0||
        raw.snapshot.currency!=='VND'))
    throw new Error('EVENT_AMOUNT_INVALID');
  return raw as NotificationEvent;
}
export const parseDriverNotificationEvent=parseNotificationEvent;
