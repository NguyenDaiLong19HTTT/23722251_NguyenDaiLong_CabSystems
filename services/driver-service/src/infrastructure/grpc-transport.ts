import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { bindServer, closeServer, createServer, serviceDefinition } from '@cab/grpc-transport';
import type { TlsMaterial } from '@cab/grpc-transport';
import { DriverConfig } from './runtime-config.js';

@Injectable()
export class DriverGrpcTransport implements OnModuleDestroy {
  private server?:grpc.Server;
  constructor(readonly config:DriverConfig) {}
  async start(tls:TlsMaterial,address:string,handlers:grpc.UntypedServiceImplementation,
    applicationHandlers:grpc.UntypedServiceImplementation={},
    internalHandlers:grpc.UntypedServiceImplementation={}):Promise<number> {
    if (this.server) throw new Error('Driver gRPC listener already initialized');
    const server=createServer('driver-service',tls);this.server=server;
    try {
      server.addService(serviceDefinition('cab.gateway.v1.DriverFacadeService',
        'proto/cab/gateway/v1/driver_facade.proto'),handlers);
      server.addService(serviceDefinition('cab.gateway.v1.DriverApplicationFacadeService',
        'proto/cab/gateway/v1/driver_registration_facade.proto'),applicationHandlers);
      server.addService(serviceDefinition('cab.internal.v1.DriverInternalService',
        'proto/cab/internal/v1/driver.proto'),internalHandlers);
      const port=await bindServer(server,address,tls);
      this.config.listenerEnabled=true;return port;
    } catch (error) {await this.onModuleDestroy();throw error;}
  }
  async onModuleDestroy():Promise<void> {
    if (this.server) await closeServer(this.server);
    this.server=undefined;this.config.listenerEnabled=false;
  }
}
