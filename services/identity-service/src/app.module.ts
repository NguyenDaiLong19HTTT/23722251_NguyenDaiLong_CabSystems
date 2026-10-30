import { IdentityGrpcTransport } from './infrastructure/grpc-transport.js';
import { Module } from '@nestjs/common';
import { IdentityConfig } from './infrastructure/runtime-config.js';
import { IdentityRuntime } from './infrastructure/runtime.js';
import { IdentityPersistence, IDENTITY_PRISMA_CLIENT_FACTORY, IDENTITY_RUNTIME_DATABASE_URL } from './infrastructure/persistence.js';
import { createIdentityClient } from './infrastructure/prisma/client.js';

@Module({
  providers: [IdentityGrpcTransport, IdentityConfig, IdentityRuntime],
})
export class IdentityCoreModule {}

@Module({
  imports: [IdentityCoreModule],
  providers: [
    { provide: IDENTITY_RUNTIME_DATABASE_URL, useFactory: () => {
      const value = process.env.CAB_IDENTITY_RUNTIME_URL;
      if (!value) throw new Error('Identity runtime database configuration is missing');
      return value;
    } },
    { provide: IDENTITY_PRISMA_CLIENT_FACTORY, useValue: createIdentityClient },
    IdentityPersistence,
  ],
})
export class IdentityModule {}
