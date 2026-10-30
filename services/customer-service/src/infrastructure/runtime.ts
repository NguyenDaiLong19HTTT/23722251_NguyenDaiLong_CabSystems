import { Injectable } from '@nestjs/common';
import { CustomerConfig } from './runtime-config.js';

// Constructor injection intentionally relies on decorator metadata.
@Injectable()
export class CustomerRuntime {
  constructor(readonly config: CustomerConfig) {}
}
