import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { IdentityCoreModule, IdentityModule } from '../app.module.js';
import { readTlsFromEnvironment } from '@cab/grpc-transport';
import { IdentityGrpcTransport } from '../infrastructure/grpc-transport.js';
import { IdentityPersistence } from '../infrastructure/persistence.js';
import { IdentityCrypto } from '../infrastructure/crypto.js';
import { IdentityCustomerDemo } from '../application/customer-demo.js';
import { IdentityDriverRegistration } from '../application/driver-registration.js';
import type { PrismaClient } from '../infrastructure/prisma/generated/client.js';
import type * as grpc from '@grpc/grpc-js';

// Production context requires the runtime database and never runs migration.
export async function bootstrap() {
  const app = await NestFactory.createApplicationContext(IdentityModule, {
    logger: false,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  return app;
}

// Explicit database-free scaffold smoke; never used by the production entry point.
export async function bootstrapCoreSmoke() {
  return NestFactory.createApplicationContext(IdentityCoreModule, { logger: false, abortOnError: false });
}

export async function bootstrapNetwork() {
  const app = await bootstrap();
  try {
    const address = process.env.IDENTITY_SERVICE_GRPC_BIND;
    if (!address) throw new Error('Missing gRPC bind configuration');
    const commands = new IdentityCustomerDemo(app.get(IdentityPersistence).client as PrismaClient,
      new IdentityCrypto());
    const driverRegistration=new IdentityDriverRegistration(
      app.get(IdentityPersistence).client as PrismaClient,new IdentityCrypto());
    const wrap = (fn:(request:unknown,metadata:grpc.Metadata)=>Promise<unknown>) =>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>) => {
        void fn(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));
      };
    try {
      await app.get(IdentityGrpcTransport).start(readTlsFromEnvironment('IDENTITY_SERVICE'), address,{
        RegisterCustomer:wrap((request,metadata)=>commands.register(request,metadata)),
        GetCustomerRegistration:wrap((request,metadata)=>commands.lookup(request,metadata)),
        Login:wrap(request=>commands.login(request)),
        GetMyAccount:wrap((_request,metadata)=>commands.me(metadata)),
      },{
        VerifyAccountEligibility:wrap(request=>commands.eligibility(request)),
        VerifyUserIdentity:wrap((request,metadata)=>commands.verifyInternal(request,metadata)),
        VerifyRatingUserIdentity:wrap((request,metadata)=>commands.verifyInternal(request,metadata)),
        GetAccountContact:wrap((request,metadata)=>commands.contact(request,metadata)),
      },{
        RequestDriverOtp:wrap(request=>driverRegistration.requestOtp(request)),
        VerifyDriverOtp:wrap(request=>driverRegistration.verifyOtp(request)),
        SubmitDriverApplication:wrap((request,metadata)=>driverRegistration.submit(request,metadata)),
        GetDriverRegistrationOperation:wrap((request,metadata)=>driverRegistration.lookup(request,metadata)),
      });
      commands.startRecovery();
      driverRegistration.startRecovery();
      app.enableShutdownHooks();
      const close = app.close.bind(app);
      app.close = async () => { commands.close();driverRegistration.close(); await close(); };
    } catch (error) { commands.close();driverRegistration.close(); throw error; }
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
