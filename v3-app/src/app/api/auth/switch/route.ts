import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { setSessionCookie, apiOk, apiError } from "@/lib/auth";

/**
 * POST /api/auth/switch — 模拟登录/切换角色（写 v3_session cookie）。
 * 入参：{ userId }。返回当前用户简表。
 */
export async function POST(req: NextRequest) {
  let body: { userId?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const userId = body.userId?.trim();
  if (!userId) return apiError({ code: "BAD_REQUEST", message: "缺少 userId", status: 400 });

  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (rows.length === 0 || !rows[0].enabled) {
    return apiError({ code: "NOT_FOUND", message: "用户不存在或已停用", status: 404 });
  }

  const u = rows[0];
  const res = apiOk({
    id: u.id,
    name: u.name,
    roleCodes: u.roleCodes.split(",").map((s) => s.trim()).filter(Boolean),
  });
  setSessionCookie(res, u.id);
  return res;
}
