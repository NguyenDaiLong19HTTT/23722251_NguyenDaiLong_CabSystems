import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { bindServer, closeServer, createServer, serviceDefinition } from '@cab/grpc-transport';
import type { TlsMaterial } from '@cab/grpc-transport';
import { IdentityConfig } from './runtime-config.js';

@Injectable()
export class IdentityGrpcTransport implements OnModuleDestroy {
  private server?: grpc.Server;
  private port?: number;
  constructor(readonly config: IdentityConfig) {}

  async start(tls: TlsMaterial, address: string,
    facadeHandlers: grpc.UntypedServiceImplementation = {},
    internalHandlers: grpc.UntypedServiceImplementation = {},
    driverRegistrationHandlers:grpc.UntypedServiceImplementation = {}): Promise<number> {
    if (this.server) throw new Error('gRPC listener already initialized');
    const server = createServer('identity-service', tls);
    this.server = server;
    try {
      server.addService(serviceDefinition('cab.gateway.v1.IdentityFacadeService',
        'proto/cab/gateway/v1/customer_facade.proto'), facadeHandlers);
      server.addService(serviceDefinition('cab.internal.v1.IdentityInternalService',
        'proto/cab/internal/v1/identity.proto'), internalHandlers);
      server.addService(serviceDefinition('cab.gateway.v1.IdentityDriverRegistrationFacadeService',
        'proto/cab/gateway/v1/driver_registration_facade.proto'),driverRegistrationHandlers);
      this.port = await bindServer(server, address, tls);
      this.config.listenerEnabled = true;
      return this.port;
    } catch (error) {
      await this.onModuleDestroy();
      throw error;
    }
  }

  get listeningPort(): number | undefined { return this.port; }

  async onModuleDestroy(): Promise<void> {
    if (this.server) await closeServer(this.server);
    this.server = undefined;
    this.port = undefined;
    this.config.listenerEnabled = false;
  }
}
