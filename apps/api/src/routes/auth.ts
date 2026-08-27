import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  AccountProfile, DeleteAccountRequest, DeleteAccountResponse, LoginRequest, LoginResponse,
  PersonCreate, RegisterRequest,
} from '@amr/contracts';
import { newPersonSlug, serverTimestamp } from '@amr/storage';
import { checkLoginRateLimit, checkRegistrationRateLimit, hashPassword, signToken, verifyPassword } from '../auth.js';
import { db } from '../db/client.js';
import { account, person, personAccess } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../journal.js';
import { createOwnedPerson, newId } from '../person-service.js';

function hasConstraint(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const candidate = current as { message?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.constraint === constraint || candidate.constraint_name === constraint) return true;
    if (typeof candidate.message === 'string' && candidate.message.includes(constraint)) return true;
    current = candidate.cause;
  }
  return false;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/login',
    input: LoginRequest,
    output: LoginResponse,
    auth: 'none',
    handler: async ({ input, req }) => {
      checkLoginRateLimit(req.ip);
      // 失败一律 401,不区分"用户不存在/密码错"(spec m0-05 §1);
      // 用户不存在时也跑一次 verify(恒定代价的朴素形态,不作验收项)
      const rows = await db.select().from(account).where(eq(account.email, input.email)).limit(1);
      const acct = rows[0];
      const hash =
        acct?.passwordHash ??
        '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const ok = await verifyPassword(hash, input.password).catch(() => false);
      if (!acct || acct.archivedAt !== null || !ok) throw new ApiError('unauthenticated', '认证失败');
      return { access_token: await signToken(acct.id, acct.tokenEpoch) };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    input: RegisterRequest,
    output: LoginResponse,
    auth: 'none',
    status: 201,
    handler: async ({ input, req }) => {
      checkRegistrationRateLimit(req.ip);
      const accountId = newId();
      const passwordHash = await hashPassword(input.password);
      const personInput = PersonCreate.parse({
        display_name: input.display_name,
        birth_date: input.birth_date,
        sex_at_birth: input.sex_at_birth,
        relation_to_owner: 'self',
      });

      for (let attempt = 0; ; attempt++) {
        const slug = newPersonSlug();
        try {
          await db.transaction(async (tx) => {
            await tx.insert(account).values({
              id: accountId,
              email: input.email,
              passwordHash,
              displayName: input.display_name,
              timezone: input.timezone,
            });
            await createOwnedPerson(tx, personInput, accountId, slug);
          });
          return { access_token: await signToken(accountId, 0) };
        } catch (error) {
          if (hasConstraint(error, 'account_email_unique')) {
            throw new ApiError('email_already_registered', '该邮箱已注册,请直接登录');
          }
          if (attempt < 5 && hasConstraint(error, 'person_slug_unique')) continue;
          throw error;
        }
      }
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/account',
    input: AccountProfile.pick({}).strict(),
    output: AccountProfile,
    handler: async ({ accountId }) => {
      const rows = await db.select().from(account).where(eq(account.id, accountId)).limit(1);
      const acct = rows[0];
      if (!acct || acct.archivedAt !== null) throw new ApiError('unauthenticated', '凭证已失效');
      return {
        id: acct.id,
        email: acct.email,
        display_name: acct.displayName,
        timezone: acct.timezone,
        created_at: acct.createdAt.toISOString(),
      };
    },
  });

  defineRoute(app, {
    method: 'DELETE',
    url: '/api/v1/account',
    input: DeleteAccountRequest,
    output: DeleteAccountResponse,
    handler: async ({ accountId, input }) => {
      const replacementPasswordHash = await hashPassword(`${newId()}-${newId()}`);
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'account:' + accountId}, 0))`);
        const rows = await tx.select().from(account).where(eq(account.id, accountId)).limit(1);
        const acct = rows[0];
        if (!acct || acct.archivedAt !== null) throw new ApiError('unauthenticated', '凭证已失效');
        if (!(await verifyPassword(acct.passwordHash, input.current_password).catch(() => false))) {
          throw new ApiError('unauthenticated', '当前密码不正确');
        }

        const grants = await tx
          .select({ personId: personAccess.personId, role: personAccess.role, personSlug: person.slug })
          .from(personAccess)
          .innerJoin(person, eq(person.id, personAccess.personId))
          .where(eq(personAccess.accountId, accountId));
        for (const grant of grants) {
          await appendAudit(tx, {
            schema_version: '1.0',
            op: 'access_revoke',
            account_id: accountId,
            person_id: grant.personId,
            person_slug: grant.personSlug,
            role: grant.role,
            at: serverTimestamp(),
          });
        }

        await tx.delete(personAccess).where(eq(personAccess.accountId, accountId));
        await tx.update(account).set({
          email: `deleted+${accountId}@invalid.local`,
          displayName: '已注销账户',
          timezone: 'UTC',
          passwordHash: replacementPasswordHash,
          tokenEpoch: acct.tokenEpoch + 1,
          archivedAt: new Date(),
        }).where(eq(account.id, accountId));
      });
      return { deleted: true as const };
    },
  });
}
