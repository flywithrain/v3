import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db-schema";
import { apiOk, getCurrentUser } from "@/lib/auth";

/** GET /api/users — 列出全部用户供角色切换页使用（模拟登录场景不鉴权） */
export async function GET(req: NextRequest) {
  // 检测当前登录用户是否为 admin（用于返回 disabled 用户列表）
  const me = await getCurrentUser(req);
  const isAdmin = me?.roleCodes.includes("admin");

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      roleCodes: users.roleCodes,
      enabled: users.enabled,
    })
    .from(users);

  // 未登录用户只能看到启用的账号；管理员可以看到全部
  const visible = isAdmin ? rows : rows.filter((u) => u.enabled);

  return apiOk(
    visible.map((u) => ({
      id: u.id,
      name: u.name,
      roleCodes: u.roleCodes.split(",").map((s) => s.trim()).filter(Boolean),
      enabled: u.enabled,
    }))
  );
}
