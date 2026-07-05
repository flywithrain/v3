import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import type { ApiException, RoleCode, SimpleUser } from "@/types";

export const SESSION_COOKIE = "v3_session";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 天

/** 读取当前会话用户（按 cookie v3_session 反解 userId 查 users 表） */
export async function getCurrentUser(req?: NextRequest): Promise<SimpleUser | null> {
  const userId = await readSessionUserId(req);
  if (!userId) return null;
  try {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (rows.length === 0 || !rows[0].enabled) return null;
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      roleCodes: parseRoles(r.roleCodes),
    };
  } catch {
    return null;
  }
}

/** 在 Server Component 内读取会话用户（无 Request 对象时用全局 headers/cookies） */
export async function getCurrentUserFromCookies(): Promise<SimpleUser | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const userId = store.get(SESSION_COOKIE)?.value;
  if (!userId) return null;
  try {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (rows.length === 0 || !rows[0].enabled) return null;
    const r = rows[0];
    return { id: r.id, name: r.name, roleCodes: parseRoles(r.roleCodes) };
  } catch {
    return null;
  }
}

async function readSessionUserId(req?: NextRequest): Promise<string | null> {
  if (req) return req.cookies.get(SESSION_COOKIE)?.value ?? null;
  // 在 Server Component / Route Handler 没有传 req 时，从 next/headers 取
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

function parseRoles(raw: string): RoleCode[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean) as RoleCode[];
}

/** 当前用户是否拥有任一指定角色 */
export function hasAnyRole(user: SimpleUser | null, ...roles: RoleCode[]): boolean {
  if (!user) return false;
  return roles.some((r) => user.roleCodes.includes(r));
}

/** 设置会话 cookie（在 /api/auth/switch route 中调用） */
export function setSessionCookie(res: NextResponse, userId: string): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: userId,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
}

/** 清除会话 cookie */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** 包装一个 API 助手：若用户未登录或缺少指定角色，返回标准 401/403 错误体。 */
export function requireRoles(user: SimpleUser | null, ...roles: RoleCode[]): NextResponse | null {
  if (!user) {
    return apiError({ code: "UNAUTHORIZED", message: "未登录或会话已失效", status: 401 });
  }
  if (roles.length > 0 && !hasAnyRole(user, ...roles)) {
    return apiError({ code: "FORBIDDEN", message: "当前角色无权执行此操作", status: 403 });
  }
  return null;
}

/** 标准错误响应 */
export function apiError(exc: ApiException): NextResponse {
  return NextResponse.json({ code: exc.code, message: exc.message }, { status: exc.status });
}

/** 标准成功响应 */
export function apiOk<T>(data: T): NextResponse {
  return NextResponse.json({ ok: true, data });
}
