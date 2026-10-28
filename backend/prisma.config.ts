import { defineConfig } from 'prisma/config';
import { resolveDatabaseUrl } from './src/core/config.js';

const hasConnection = Boolean(process.env.DATABASE_URL) ||
  ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_HOST', 'DB_PORT', 'POSTGRES_DB']
    .every((name) => Boolean(process.env[name]));

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // Client generation and builds do not require a running database or .env.
  datasource: hasConnection ? { url: resolveDatabaseUrl() } : undefined,
});
