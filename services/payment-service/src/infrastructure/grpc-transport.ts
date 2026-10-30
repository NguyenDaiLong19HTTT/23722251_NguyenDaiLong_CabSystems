import {Injectable,OnModuleDestroy} from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import {bindServer,closeServer,createServer,serviceDefinition} from '@cab/grpc-transport';
import type {TlsMaterial} from '@cab/grpc-transport';

@Injectable()
export class PaymentGrpcTransport implements OnModuleDestroy {
  private server?:grpc.Server;
  async start(tls:TlsMaterial,address:string,handlers:grpc.UntypedServiceImplementation,
    facadeHandlers:grpc.UntypedServiceImplementation):Promise<void> {
    if (this.server) throw new Error('Payment listener already initialized');
    const server=createServer('payment-service',tls);
    this.server=server;
    try {
      server.addService(serviceDefinition('cab.internal.v1.PaymentInternalService',
        'proto/cab/internal/v1/payment.proto'),handlers);
      server.addService(serviceDefinition('cab.gateway.v1.PaymentFacadeService',
        'proto/cab/gateway/v1/payment_facade.proto'),facadeHandlers);
      await bindServer(server,address,tls);
    } catch(error) {await this.onModuleDestroy();throw error;}
  }
  async onModuleDestroy():Promise<void> {
    const server=this.server;this.server=undefined;
    if (server) await closeServer(server);
  }
}
