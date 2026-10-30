import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CustomerCoreModule, CustomerModule } from '../app.module.js';
import { readTlsFromEnvironment } from '@cab/grpc-transport';
import { CustomerGrpcTransport } from '../infrastructure/grpc-transport.js';
import { CustomerCommands } from '../application/customer-commands.js';
import { CustomerProfileService } from '../application/customer-profile.js';
import { CustomerGuards } from '../application/customer-guards.js';
import { CustomerPersistence } from '../infrastructure/persistence.js';
import type { PrismaClient } from '../infrastructure/prisma/generated/client.js';
import type * as grpc from '@grpc/grpc-js';

// Production context requires the runtime database and never runs migration.
export async function bootstrap() {
  const app = await NestFactory.createApplicationContext(CustomerModule, {
    logger: false,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  return app;
}

// Explicit database-free scaffold smoke; never used by the production entry point.
export async function bootstrapCoreSmoke() {
  return NestFactory.createApplicationContext(CustomerCoreModule, { logger: false, abortOnError: false });
}

export async function bootstrapNetwork() {
  const app = await bootstrap();
  try {
    const address = process.env.CUSTOMER_SERVICE_GRPC_BIND;
    if (!address) throw new Error('Missing gRPC bind configuration');
    const commands = app.get(CustomerCommands);
    commands.ensureReady();
    const profile = new CustomerProfileService(app.get(CustomerPersistence).client as PrismaClient);
    const guards = new CustomerGuards(app.get(CustomerPersistence).client as PrismaClient);
    const wrap = (fn:(request:unknown)=>Promise<unknown>) =>
      (call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>) => {
        void fn(call.request).then(value=>callback(null,value),error=>callback(error));
      };
    try {
      await app.get(CustomerGrpcTransport).start(readTlsFromEnvironment('CUSTOMER_SERVICE'), address,{
        ProvisionCustomer:wrap(request=>commands.provision(request)),
        GetCustomerProvision:wrap(request=>commands.get(request)),
        CancelCustomerProvision:wrap(request=>commands.cancel(request)),
        AcquireGuard:wrap(request=>guards.acquire(request)),
        GetGuard:wrap(request=>guards.get(request)),
        BindGuard:wrap(request=>guards.bind(request)),
        RestoreBookingGuard:wrap(request=>guards.restore(request)),
        ReleaseGuard:wrap(request=>guards.release(request)),
        CancelBookingGuard:wrap(request=>guards.cancelBooking(request)),
      },{
        GetCustomer:(call:grpc.ServerUnaryCall<unknown,unknown>,callback:grpc.sendUnaryData<unknown>) => {
          void profile.get(call.request,call.metadata).then(value=>callback(null,value),error=>callback(error));
        },
      });
      const close=app.close.bind(app);
      app.close=async()=>{profile.close();guards.close();await close();};
    } catch (error) {profile.close();guards.close();throw error;}
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
