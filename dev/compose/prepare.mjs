import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
const source=join(root,'.secrets','customer-dev');
if (!existsSync(join(source,'project'))) throw new Error('Existing CAB dev setup missing');
const cursorKey=join(source,'payment_cursor_key');
if (!existsSync(cursorKey)) writeFileSync(cursorKey,randomBytes(32).toString('base64url'),
  {flag:'wx',mode:0o600});
const roles={
  identity:['identity_runtime_password',...['contact','snapshot','lookup','idempotency',
    'fingerprint','recovery','refresh','receipt','jwt','otp','verification']
    .map(name=>`identity_${name}_key`)],
  customer:['customer_runtime_password','customer_receipt_key'],
  driver:['driver_runtime_password','driver_license_key','driver_application_key',
    'rabbit_driver_password'],
  payment:['payment_runtime_password','rabbit_payment_password','payment_cursor_key'],
  trip:['trip_runtime_password','rabbit_trip_password','trip_cursor_key'],
  booking:['booking_runtime_password','rabbit_booking_password','booking_cursor_key'],
  rating:['rating_runtime_password','rating_cursor_key'],
  'payment-broker':['rabbit_admin_password','rabbit_payment_password'],
  'trip-broker':['rabbit_admin_password','rabbit_trip_password'],
  'booking-broker':['rabbit_admin_password','rabbit_booking_password'],
  notification:['mongo_notification_password','rabbit_notification_password',
    'notification_cursor_key','notification_dlq_key'],
  'migrate-identity':['identity_migration_password'],
  'migrate-customer':['customer_migration_password'],
  'migrate-driver':['driver_migration_password'],
  'migrate-payment':['payment_migration_password'],
  'migrate-trip':['trip_migration_password'],
  'migrate-booking':['booking_migration_password'],
  'migrate-rating':['rating_migration_password'],
};
for (const [role,names] of Object.entries(roles)) {
  const target=join(source,'compose-runtime',role);
  mkdirSync(target,{recursive:true});
  for (const name of names) {
    const from=join(source,name),to=join(target,name);
    const bytes=readFileSync(from);
    if (existsSync(to)) {
      const current=readFileSync(to);
      if (current.length!==bytes.length||!timingSafeEqual(current,bytes))
        throw new Error(`Compose runtime copy differs from source: ${role}/${name}`);
    } else writeFileSync(to,bytes,{flag:'wx',mode:0o600});
  }
}
for (const role of ['gateway','identity','customer','driver','notification','payment','trip',
  'booking','rating','broker'])
  mkdirSync(join(source,'compose-pki',role),{recursive:true});
console.info('CAB Compose runtime scopes and PKI directories prepared; credentials not printed.');
