import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

export function resolveDatabaseUrl(override?: string): string {
  const explicit = override || process.env.DATABASE_URL;
  if (explicit) return explicit.replace(/^postgresql\+psycopg:/, 'postgresql:');
  const required = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_HOST', 'DB_PORT', 'POSTGRES_DB'];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  }
  const url = new URL('postgresql://localhost');
  url.username = process.env.POSTGRES_USER!;
  url.password = process.env.POSTGRES_PASSWORD!;
  url.hostname = process.env.POSTGRES_HOST!;
  url.port = process.env.DB_PORT!;
  url.pathname = `/${encodeURIComponent(process.env.POSTGRES_DB!)}`;
  return url.toString();
}
