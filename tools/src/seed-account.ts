// spec m0-05 §1:幂等 seed(同 email 再跑 = 更新密码)。tools 允许直连 DB。
import { hash } from '@node-rs/argon2';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';

const email = (process.env.SEED_EMAIL ?? 'owner@local.test').toLowerCase();
const password = process.env.SEED_PASSWORD ?? 'm0-acceptance-password';
const displayName = process.env.SEED_DISPLAY_NAME ?? '项目所有者';
const timezone = process.env.SEED_TIMEZONE ?? 'Asia/Shanghai';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr', {
  max: 1, onnotice: () => {},
});

const passwordHash = await hash(password, { memoryCost: 65536, timeCost: 3, parallelism: 4 });
const rows = await sql`
  insert into account (id, email, password_hash, display_name, timezone)
  values (${uuidv7()}, ${email}, ${passwordHash}, ${displayName}, ${timezone})
  on conflict (email) do update set password_hash = ${passwordHash}
  returning id
`;
console.log(`seeded account ${email} -> ${rows[0]!['id']}`);
await sql.end();
