import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { IdentityCoreModule } from '../src/app.module.js';
import { IdentityConfig } from '../src/infrastructure/runtime-config.js';
import { IdentityRuntime } from '../src/infrastructure/runtime.js';
import { bootstrapCoreSmoke } from '../src/interfaces/bootstrap.js';

it('boots and closes identity-service with real constructor DI and metadata', async () => {
  expect(Reflect.getMetadata('design:paramtypes', IdentityRuntime)).toEqual([IdentityConfig]);
  const app = await bootstrapCoreSmoke();
  expect(app.select(IdentityCoreModule)).toBeDefined();
  try {
    const runtime = app.get(IdentityRuntime);
    expect(runtime).toBeInstanceOf(IdentityRuntime);
    expect(runtime.config).toBe(app.get(IdentityConfig));
    expect(runtime.config.transport).toBe('grpc');
    expect(runtime.config.listenerEnabled).toBe(false);
    expect(existsSync(runtime.config.facadeProtoPath)).toBe(true);
    expect(runtime.config.facadeService).toBe('IdentityFacadeService');
  } finally {
    await app.close();
  }
});
