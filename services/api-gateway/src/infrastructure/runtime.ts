import { Injectable } from '@nestjs/common';
import { GatewayConfig } from './runtime-config.js';

// Constructor injection intentionally relies on decorator metadata.
@Injectable()
export class GatewayRuntime {
  constructor(readonly config: GatewayConfig) {}
}
