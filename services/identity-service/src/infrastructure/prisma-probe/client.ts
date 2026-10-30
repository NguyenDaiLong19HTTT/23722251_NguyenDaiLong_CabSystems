// Technical probe only: not registered in the application module.
import { PrismaClient, Prisma } from './generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

export function createIdentityProbe(connectionString: string) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=8000 -c lock_timeout=5000' }),
    transactionOptions: { maxWait: 5000, timeout: 10000 },
  });
}

// Decimal's default significant precision is insufficient for NUMERIC(30,12).
// Clone is local to this probe adapter; never mutate global Decimal settings.
const ProbeDecimal = Prisma.Decimal.clone({ precision: 40, rounding: Prisma.Decimal.ROUND_HALF_UP });
export function identityProbeDecimal(value: string) { return new ProbeDecimal(value); }
