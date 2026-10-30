import { Injectable } from '@nestjs/common';

@Injectable()
export class GatewayConfig {
  readonly host = process.env.API_GATEWAY_HOST ?? '127.0.0.1';
  readonly port: number;

  constructor() {
    const rawPort = process.env.API_GATEWAY_PORT ?? '3000';
    if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
      throw new Error('API_GATEWAY_PORT must be an integer from 1 to 65535');
    }
    this.port = Number(rawPort);
  }
}
