import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { CustomerCoreModule } from '../src/app.module.js';
import { CustomerConfig } from '../src/infrastructure/runtime-config.js';
import { CustomerRuntime } from '../src/infrastructure/runtime.js';
import { bootstrapCoreSmoke } from '../src/interfaces/bootstrap.js';

it('boots and closes customer-service with real constructor DI and metadata', async () => {
  expect(Reflect.getMetadata('design:paramtypes', CustomerRuntime)).toEqual([CustomerConfig]);
  const app = await bootstrapCoreSmoke();
  try {
    const runtime = app.get(CustomerRuntime);
    expect(runtime).toBeInstanceOf(CustomerRuntime);
    expect(runtime.config).toBe(app.get(CustomerConfig));
    expect(runtime.config.transport).toBe('grpc');
    expect(runtime.config.listenerEnabled).toBe(false);
    expect(existsSync(runtime.config.facadeProtoPath)).toBe(true);
    expect(runtime.config.facadeService).toBe('CustomerFacadeService');
  } finally {
    await app.close();
  }
});
