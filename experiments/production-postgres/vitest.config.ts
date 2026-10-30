import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' }, jsc: { target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  test: { environment: 'node', include: ['experiments/production-postgres/**/*.spec.ts'],
    testTimeout: 15000, hookTimeout: 15000 },
});
