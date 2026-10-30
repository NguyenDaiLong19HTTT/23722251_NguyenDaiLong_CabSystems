import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { expect, it } from 'vitest';
import { GatewayModule } from '../src/app.module.js';
import { GatewayConfig } from '../src/infrastructure/runtime-config.js';
import { GatewayRuntime } from '../src/infrastructure/runtime.js';

it('boots and closes api-gateway with real constructor DI and metadata', async () => {
  expect(Reflect.getMetadata('design:paramtypes', GatewayRuntime)).toEqual([GatewayConfig]);
  const app = await NestFactory.createApplicationContext(GatewayModule, {
    logger: false, abortOnError: false,
  });
  try {
    const runtime = app.get(GatewayRuntime);
    expect(runtime).toBeInstanceOf(GatewayRuntime);
    expect(runtime.config).toBe(app.get(GatewayConfig));
    expect(runtime.config.port).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
