import {Injectable,OnModuleDestroy} from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import {bindServer,closeServer,createServer,serviceDefinition} from '@cab/grpc-transport';
import type {TlsMaterial} from '@cab/grpc-transport';

@Injectable()
export class NotificationGrpcTransport implements OnModuleDestroy {
  private server?:grpc.Server;
  async start(tls:TlsMaterial,address:string,handlers:grpc.UntypedServiceImplementation):Promise<void> {
    if (this.server) throw new Error('Notification listener already started');
    const server=createServer('notification-service',tls);this.server=server;
    try {
      server.addService(serviceDefinition('cab.gateway.v1.NotificationFacadeService',
        'proto/cab/gateway/v1/notification_facade.proto'),handlers);
      await bindServer(server,address,tls);
    } catch(error) {await this.onModuleDestroy();throw error;}
  }
  async onModuleDestroy():Promise<void> {
    if (this.server) await closeServer(this.server);
    this.server=undefined;
  }
}
