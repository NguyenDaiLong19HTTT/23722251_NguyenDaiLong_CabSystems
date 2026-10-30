import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { GatewayModule } from '../app.module.js';
import { GatewayRuntime } from '../infrastructure/runtime.js';

export async function createHttpApplication() {
  return NestFactory.create(GatewayModule, { logger: false, abortOnError: false });
}

export async function bootstrap() {
  const app = await createHttpApplication();
  const { config } = app.get(GatewayRuntime);
  app.enableShutdownHooks();
  try {
    await app.listen(config.port, config.host);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
