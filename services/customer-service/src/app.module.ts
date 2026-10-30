import { CustomerGrpcTransport } from './infrastructure/grpc-transport.js';
import { Module } from '@nestjs/common';
import { CustomerConfig } from './infrastructure/runtime-config.js';
import { CustomerRuntime } from './infrastructure/runtime.js';
import { CustomerPersistence, CUSTOMER_PRISMA_CLIENT_FACTORY, CUSTOMER_RUNTIME_DATABASE_URL } from './infrastructure/persistence.js';
import { createCustomerClient } from './infrastructure/prisma/client.js';
import { CustomerCommands } from './application/customer-commands.js';

@Module({
  providers: [CustomerGrpcTransport, CustomerConfig, CustomerRuntime],
})
export class CustomerCoreModule {}

@Module({
  imports: [CustomerCoreModule],
  providers: [
    { provide: CUSTOMER_RUNTIME_DATABASE_URL, useFactory: () => {
      const value = process.env.CAB_CUSTOMER_RUNTIME_URL;
      if (!value) throw new Error('Customer runtime database configuration is missing');
      return value;
    } },
    { provide: CUSTOMER_PRISMA_CLIENT_FACTORY, useValue: createCustomerClient },
    CustomerPersistence,
    CustomerCommands,
  ],
})
export class CustomerModule {}
