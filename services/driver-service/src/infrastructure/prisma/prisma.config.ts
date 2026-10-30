import { defineConfig } from 'prisma/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  schema:fileURLToPath(new URL('./schema.prisma',import.meta.url)),
  migrations:{path:fileURLToPath(new URL('./migrations/',import.meta.url))},
  datasource:{url:process.env.CAB_DRIVER_MIGRATION_URL},
});
