import {Injectable,OnModuleDestroy} from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import {bindServer,closeServer,createServer,serviceDefinition} from '@cab/grpc-transport';
import type {TlsMaterial} from '@cab/grpc-transport';

@Injectable()
export class TripGrpcTransport implements OnModuleDestroy {
  private server?:grpc.Server;
  async start(tls:TlsMaterial,address:string,internal:grpc.UntypedServiceImplementation,
    facade:grpc.UntypedServiceImplementation):Promise<void> {
    if(this.server) throw new Error('Trip listener already initialized');
    const server=createServer('trip-service',tls);this.server=server;
    try {
      server.addService(serviceDefinition('cab.internal.v1.TripInternalService',
        'proto/cab/internal/v1/trip.proto'),internal);
      server.addService(serviceDefinition('cab.gateway.v1.TripFacadeService',
        'proto/cab/gateway/v1/trip_facade.proto'),facade);
      await bindServer(server,address,tls);
    } catch(error) {await this.onModuleDestroy();throw error;}
  }
  async onModuleDestroy():Promise<void> {const server=this.server;this.server=undefined;
    if(server) await closeServer(server);}
}
