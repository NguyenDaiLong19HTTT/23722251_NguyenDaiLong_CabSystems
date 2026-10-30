import { Injectable } from '@nestjs/common';
import { IdentityConfig } from './runtime-config.js';

// Constructor injection intentionally relies on decorator metadata.
@Injectable()
export class IdentityRuntime {
  constructor(readonly config: IdentityConfig) {}
}
