import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";

/** GET /api/users — 列出全部用户供角色切换页使用（需登录） */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

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
