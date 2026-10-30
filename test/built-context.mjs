// Verify tsc output under Node as well as SWC-transformed source under Vitest.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';

for (const [service, prefix] of [
  ['api-gateway', 'Gateway'],
  ['identity-service', 'Identity'],
  ['customer-service', 'Customer'],
  ['driver-service', 'Driver'],
]) {
  const { [service === 'api-gateway' ? prefix + 'Module' : prefix + 'CoreModule']: Module } = await import(
    `../services/${service}/dist/app.module.js`
  );
  const { [prefix + 'Config']: Config } = await import(
    `../services/${service}/dist/infrastructure/runtime-config.js`
  );
  const { [prefix + 'Runtime']: Runtime } = await import(
    `../services/${service}/dist/infrastructure/runtime.js`
  );
  assert.deepEqual(Reflect.getMetadata('design:paramtypes', Runtime), [Config]);
  const app = await NestFactory.createApplicationContext(Module, {
    logger: false, abortOnError: false,
  });
  try {
    assert.equal(app.get(Runtime).config, app.get(Config));
    if (service !== 'api-gateway') {
      assert.equal(app.get(Config).listenerEnabled, false);
      assert.equal(existsSync(app.get(Config).facadeProtoPath), true);
    }
  } finally {
    await app.close();
  }
  console.info(`PASS built ${service === 'api-gateway' ? 'context' : 'DB-free core smoke'}/metadata/DI/close: ${service}`);
}

const {PaymentCoreModule}=await import('../services/payment-service/dist/app.module.js');
const {PaymentGrpcTransport}=await import(
  '../services/payment-service/dist/infrastructure/grpc-transport.js');
const payment=await NestFactory.createApplicationContext(PaymentCoreModule,
  {logger:false,abortOnError:false});
try {assert.ok(payment.get(PaymentGrpcTransport));}
finally {await payment.close();}
console.info('PASS built DB-free core smoke/DI/close: payment-service');

const {TripCoreModule}=await import('../services/trip-service/dist/app.module.js');
const {TripGrpcTransport}=await import('../services/trip-service/dist/infrastructure/grpc-transport.js');
const trip=await NestFactory.createApplicationContext(TripCoreModule,
  {logger:false,abortOnError:false});
try {assert.ok(trip.get(TripGrpcTransport));}
finally {await trip.close();}
console.info('PASS built DB-free core smoke/DI/close: trip-service');

const {BookingCoreModule}=await import('../services/booking-service/dist/app.module.js');
const {BookingGrpcTransport}=await import('../services/booking-service/dist/infrastructure/grpc-transport.js');
const booking=await NestFactory.createApplicationContext(BookingCoreModule,
  {logger:false,abortOnError:false});
try {assert.ok(booking.get(BookingGrpcTransport));}
finally {await booking.close();}
console.info('PASS built DB-free core smoke/DI/close: booking-service');
const {RatingCoreModule}=await import('../services/rating-service/dist/app.module.js');
const {RatingGrpcTransport}=await import('../services/rating-service/dist/infrastructure/grpc-transport.js');
const rating=await NestFactory.createApplicationContext(RatingCoreModule,
  {logger:false,abortOnError:false});
try {assert.ok(rating.get(RatingGrpcTransport));}
finally {await rating.close();}
console.info('PASS built DB-free core smoke/DI/close: rating-service');
