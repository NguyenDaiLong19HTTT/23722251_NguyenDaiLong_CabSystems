import { Injectable } from '@nestjs/common';
import { fileURLToPath } from 'node:url';

@Injectable()
export class IdentityConfig {
  readonly transport = 'grpc' as const;
  listenerEnabled = false;
  readonly facadePackage = 'cab.gateway.v1';
  readonly facadeService = 'IdentityFacadeService';
  // src/infrastructure and dist/infrastructure have the same depth.
  // Refer to the authoritative contract; never copy it into this workspace.
  readonly facadeProtoPath = fileURLToPath(
    new URL('../../../../contracts/proto/cab/gateway/v1/customer_facade.proto', import.meta.url),
  );
}
