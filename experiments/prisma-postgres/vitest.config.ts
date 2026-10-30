import { defineConfig } from 'vitest/config';
import base from '../../vitest.config.js';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['experiments/prisma-postgres/probe.spec.ts',
      'experiments/prisma-postgres/lifecycle.spec.ts'],
    testTimeout: 15000,
    hookTimeout: 120000,
  },
});
