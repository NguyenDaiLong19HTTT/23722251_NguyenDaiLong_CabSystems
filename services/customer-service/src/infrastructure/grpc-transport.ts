import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { bindServer, closeServer, createServer, serviceDefinition } from '@cab/grpc-transport';
import type { TlsMaterial } from '@cab/grpc-transport';
import { CustomerConfig } from './runtime-config.js';

@Injectable()
export class CustomerGrpcTransport implements OnModuleDestroy {
  private server?: grpc.Server;
  private port?: number;
  constructor(readonly config: CustomerConfig) {}

  async start(tls: TlsMaterial, address: string,
    internalHandlers: grpc.UntypedServiceImplementation = {},
    facadeHandlers: grpc.UntypedServiceImplementation = {}): Promise<number> {
    if (this.server) throw new Error('gRPC listener already initialized');
    const server = createServer('customer-service', tls);
    this.server = server;
    try {
      server.addService(serviceDefinition('cab.gateway.v1.CustomerFacadeService',
        'proto/cab/gateway/v1/customer_facade.proto'), facadeHandlers);
      server.addService(serviceDefinition('cab.internal.v1.CustomerInternalService',
        'proto/cab/internal/v1/customer.proto'), internalHandlers);
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
