import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import type * as grpc from '@grpc/grpc-js';
import {readTlsFromEnvironment} from '@cab/grpc-transport';
import {PaymentCoreModule,PaymentModule} from '../app.module.js';
import {PricingCapture} from '../application/pricing-capture.js';
import {PaymentCommands} from '../application/payment-commands.js';
import {PaymentDatabase} from '../infrastructure/payment-database.js';
import {PaymentGrpcTransport} from '../infrastructure/grpc-transport.js';
import {PaymentNotificationPublisher} from '../infrastructure/notification-publisher.js';

export async function bootstrapCoreSmoke() {
  return NestFactory.createApplicationContext(PaymentCoreModule,{logger:false,abortOnError:false});
}
export async function bootstrapNetwork() {
  const app=await NestFactory.createApplicationContext(PaymentModule,{logger:false,abortOnError:false});
  app.enableShutdownHooks();
  try {
    const address=process.env.PAYMENT_SERVICE_GRPC_BIND;
    if (!address) throw new Error('Payment bind configuration missing');
    if (!process.env.CAB_PAYMENT_AMQPS_URL||!process.env.CAB_RABBIT_CA_FILE)
      throw new Error('Payment broker configuration missing');
    const pricing=new PricingCapture(app.get(PaymentDatabase).client);
    const commands=new PaymentCommands(app.get(PaymentDatabase).client);
    const publisher=new PaymentNotificationPublisher(app.get(PaymentDatabase).client);
    const wrap=(fn:(request:unknown,metadata:grpc.Metadata)=>Promise<unknown>)=>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>)=>{
        void fn(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));
      };
    try {await app.get(PaymentGrpcTransport).start(readTlsFromEnvironment('PAYMENT_SERVICE'),
      address,{GetPricingSnapshot:wrap(request=>pricing.get(request)),
        GetTripPaymentDecision:wrap(request=>commands.tripStartDecision(request)),
        RecordTripCancellation:wrap(request=>commands.recordTripCancellation(request))},{
        GetTripFare:wrap((request,metadata)=>commands.fare(request,metadata)),
        CreateTripPayment:wrap((request,metadata)=>commands.create(request,metadata)),
        GetTripPayment:wrap((request,metadata)=>commands.byTrip(request,metadata)),
        GetPayment:wrap((request,metadata)=>commands.byId(request,metadata)),
        ListPaymentAttempts:wrap((request,metadata)=>commands.attempts(request,metadata)),
        ConfirmCash:wrap((request,metadata)=>commands.confirmCash(request,metadata)),
        RetryPayment:wrap((request,metadata)=>commands.retry(request,metadata)),
        SimulateDemoTransfer:wrap((request,metadata)=>commands.demoResult(request,metadata)),
      });}
    catch(error) {commands.close();throw error;}
    publisher.start();
    const close=app.close.bind(app);
    app.close=async()=>{await publisher.close();commands.close();await close();};
    return app;
  } catch(error) {await app.close();throw error;}
}
