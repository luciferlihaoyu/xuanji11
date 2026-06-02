import { z } from "zod";
import * as cookie from "cookie";
import { TRPCError } from "@trpc/server";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { verifyAdminCredentials, signLocalToken } from "./local-auth";
import { createRouter, publicQuery } from "./middleware";

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
});
