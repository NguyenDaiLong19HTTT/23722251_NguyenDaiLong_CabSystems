import { PrismaClient } from './generated/client.js';
import type { PrismaPg } from '@prisma/adapter-pg';

export function createIdentityClient(adapter: PrismaPg): PrismaClient {
  return new PrismaClient({ adapter, transactionOptions: { maxWait: 5000, timeout: 10000 } });
}
