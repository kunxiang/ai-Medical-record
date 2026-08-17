import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// spec m0-02 §2.4:迁移必须可从零重放
const url = process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr';
const client = postgres(url, { max: 1, onnotice: () => {} });
const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
await migrate(drizzle(client), { migrationsFolder: folder });
await client.end();
console.log('migrations applied');
