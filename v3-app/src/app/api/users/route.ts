import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { apiOk } from "@/lib/auth";

/** GET /api/users — 列出全部用户供角色切换页使用（模拟登录场景不鉴权） */
export async function GET(_req: NextRequest) {
  // 模拟登录系统的用户列表无需鉴权——用户还没登录时需要看到可选角色列表
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      roleCodes: users.roleCodes,
      enabled: users.enabled,
    })
    .from(users)
    .where(eq(users.enabled, true));

  return apiOk(
    rows.map((u) => ({
      id: u.id,
      name: u.name,
      roleCodes: u.roleCodes.split(",").map((s) => s.trim()).filter(Boolean),
    }))
  );
}
