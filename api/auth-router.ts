import { z } from "zod";
import * as cookie from "cookie";
import { TRPCError } from "@trpc/server";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import {
  verifyAdminCredentials,
  signLocalToken,
  hashPassword,
  persistAdminPasswordChangedAt,
  getClientIp,
  isTrustedMutationRequest,
} from "./local-auth";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { env } from "./lib/env";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { localAccounts } from "@db/schema";
import { logAction } from "./lib/audit";

/** 多用户登录校验：命中 local_accounts 返回角色，否则返回 undefined 走管理员回退 */
async function verifyLocalAccount(
  username: string,
  password: string,
): Promise<"admin" | "viewer" | undefined> {
  const db = getDb();
  const rows = await db.select().from(localAccounts)
    .where(eq(localAccounts.username, username));
  const account = rows[0];
  if (!account) return undefined;
  const ok = await bcrypt.compare(password, account.passwordHash);
  if (!ok) return undefined;
  await db.update(localAccounts).set({ lastSignInAt: new Date() })
    .where(eq(localAccounts.id, account.id));
  return account.role;
}

export const authRouter = createRouter({
  // 获取当前用户信息 - 使用 publicQuery，未登录返回 null
  me: publicQuery.query((opts) => {
    return opts.ctx.user ?? null;
  }),

  // 本地管理员登录
  login: publicQuery
    .input(
      z.object({
        username: z.string().min(1, "账号不能为空"),
        password: z.string().min(1, "密码不能为空"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTrustedMutationRequest(ctx.req);

      // 多用户：先查 local_accounts（管理员创建的账户）
      const accountRole = await verifyLocalAccount(input.username, input.password);
      let role: "admin" | "viewer";
      if (accountRole) {
        role = accountRole;
      } else {
        const valid = await verifyAdminCredentials(
          input.username,
          input.password,
          getClientIp(ctx.req.headers),
        );
        if (!valid) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "账号或密码错误",
          });
        }
        role = "admin";
      }

      const token = await signLocalToken(input.username, role);
      const opts = getSessionCookieOptions(ctx.req.headers);
      ctx.resHeaders.append(
        "set-cookie",
        cookie.serialize(Session.cookieName, token, {
          httpOnly: opts.httpOnly,
          path: opts.path,
          sameSite: opts.sameSite?.toLowerCase() as "lax" | "none",
          secure: opts.secure,
          maxAge: Session.maxAgeMs / 1000,
        }),
      );

      return {
        success: true,
        user: {
          name: input.username,
          role,
        },
      };
    }),

  // ========== 多用户账户管理（admin） ==========

  listAccounts: adminQuery.query(async () => {
    const db = getDb();
    const rows = await db.select({
      id: localAccounts.id,
      username: localAccounts.username,
      role: localAccounts.role,
      createdAt: localAccounts.createdAt,
      lastSignInAt: localAccounts.lastSignInAt,
    }).from(localAccounts).orderBy(localAccounts.id);
    return rows;
  }),

  createAccount: adminQuery
    .input(z.object({
      username: z.string().min(2, "用户名至少 2 字").max(50),
      password: z.string().min(8, "密码至少 8 位").max(100),
      role: z.enum(["admin", "viewer"]).default("viewer"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const existing = await db.select({ id: localAccounts.id }).from(localAccounts)
        .where(eq(localAccounts.username, input.username));
      if (existing.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "用户名已存在" });
      }
      const passwordHash = await bcrypt.hash(input.password, 10);
      await db.insert(localAccounts).values({
        username: input.username,
        passwordHash,
        role: input.role,
      });
      await logAction(ctx.user?.id ?? null, "create", {
        entityType: "local_account",
        detail: `创建账户 ${input.username} (${input.role})`,
      });
      return { success: true };
    }),

  deleteAccount: adminQuery
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(localAccounts).where(eq(localAccounts.id, input.id));
      await logAction(ctx.user?.id ?? null, "delete", {
        entityType: "local_account",
        detail: `删除账户 #${input.id}`,
      });
      return { success: true };
    }),

  resetAccountPassword: adminQuery
    .input(z.object({
      id: z.number().int().positive(),
      password: z.string().min(8, "密码至少 8 位").max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const passwordHash = await bcrypt.hash(input.password, 10);
      await db.update(localAccounts).set({ passwordHash })
        .where(eq(localAccounts.id, input.id));
      await logAction(ctx.user?.id ?? null, "update", {
        entityType: "local_account",
        detail: `重置账户 #${input.id} 密码`,
      });
      return { success: true };
    }),

  // 登出 - 使用 publicQuery 让任何人都能调用登出
  logout: publicQuery.mutation(async ({ ctx }) => {
    const opts = getSessionCookieOptions(ctx.req.headers);
    ctx.resHeaders.append(
      "set-cookie",
      cookie.serialize(Session.cookieName, "", {
        httpOnly: opts.httpOnly,
        path: opts.path,
        sameSite: opts.sameSite?.toLowerCase() as "lax" | "none",
        secure: opts.secure,
        maxAge: 0,
      }),
    );
    return { success: true };
  }),

  // 修改密码（管理员）
  changePassword: adminQuery
    .input(
      z.object({
        currentPassword: z.string().min(1, "当前密码不能为空"),
        newPassword: z.string().min(6, "新密码至少6位").max(255, "新密码过长"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTrustedMutationRequest(ctx.req);
      const username = ctx.user?.name ?? env.adminUsername;

      // 1. 验证当前密码
      const valid = await verifyAdminCredentials(username, input.currentPassword, getClientIp(ctx.req.headers));
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "当前密码错误",
        });
      }

      // 2. 生成新密码哈希并写入 system_settings
      const newHash = await hashPassword(input.newPassword);
      const db = (await import("./queries/connection")).getDb();
      const { systemSettings } = await import("@db/schema");
      const { eq } = await import("drizzle-orm");

      const existing = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, "admin_password_hash"));

      if (existing.length > 0) {
        await db
          .update(systemSettings)
          .set({ value: newHash, updatedAt: new Date() })
          .where(eq(systemSettings.key, "admin_password_hash"));
      } else {
        await db.insert(systemSettings).values({
          key: "admin_password_hash",
          value: newHash,
          category: "security",
        });
      }

      await persistAdminPasswordChangedAt(new Date());

      const token = await signLocalToken(username);
      const opts = getSessionCookieOptions(ctx.req.headers);
      ctx.resHeaders.append(
        "set-cookie",
        cookie.serialize(Session.cookieName, token, {
          httpOnly: opts.httpOnly,
          path: opts.path,
          sameSite: opts.sameSite?.toLowerCase() as "lax" | "none",
          secure: opts.secure,
          maxAge: Session.maxAgeMs / 1000,
        }),
      );

      return { success: true };
    }),
});

function assertTrustedMutationRequest(req: Request): void {
  if (isTrustedMutationRequest(req)) return;

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Invalid request origin",
  });
}
