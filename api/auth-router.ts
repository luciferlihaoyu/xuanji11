import { z } from "zod";
import * as cookie from "cookie";
import { TRPCError } from "@trpc/server";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { verifyAdminCredentials, signLocalToken, hashPassword } from "./local-auth";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { env } from "./lib/env";

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
      const valid = await verifyAdminCredentials(input.username, input.password);
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "账号或密码错误",
        });
      }

      const token = await signLocalToken(input.username);
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
          role: "admin",
        },
      };
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
      const username = ctx.user?.name ?? env.adminUsername;

      // 1. 验证当前密码
      const valid = await verifyAdminCredentials(username, input.currentPassword);
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

      return { success: true };
    }),
});
