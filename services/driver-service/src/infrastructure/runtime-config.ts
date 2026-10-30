import { Injectable } from '@nestjs/common';
import { fileURLToPath } from 'node:url';
@Injectable()
export class DriverConfig {
  readonly transport='grpc' as const;
  listenerEnabled=false;
  readonly facadeProtoPath=fileURLToPath(new URL(
    '../../../../contracts/proto/cab/gateway/v1/driver_facade.proto',import.meta.url));
}
