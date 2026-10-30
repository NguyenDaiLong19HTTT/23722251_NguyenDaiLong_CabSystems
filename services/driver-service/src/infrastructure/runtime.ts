import { Injectable } from '@nestjs/common';
import { DriverConfig } from './runtime-config.js';
@Injectable()
export class DriverRuntime {constructor(readonly config:DriverConfig) {}}
