import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Client } from '@grpc/grpc-js';
import { createClient } from '@cab/grpc-transport';
import type { TlsMaterial } from '@cab/grpc-transport';

@Injectable()
export class GatewayGrpcClients implements OnModuleDestroy {
  private readonly clients = new Map<string,Client>();
  connect(address: string, tls: TlsMaterial, service: 'identity-service' | 'customer-service' |
    'driver-service' | 'notification-service' | 'payment-service' | 'trip-service' |
    'booking-service' | 'rating-service'): Client {
    const key = service + ':' + address;
    const existing = this.clients.get(key);
    if (existing) return existing;
    const client = createClient(address, tls, service);
    this.clients.set(key,client);
    return client;
  }
  onModuleDestroy(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
