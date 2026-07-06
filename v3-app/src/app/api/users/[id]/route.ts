import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";

/**
 * PATCH /api/users/[id] — 切换用户启用/禁用状态（仅 admin）
 * body: { enabled: boolean }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });
  if (!me.roleCodes.includes("admin")) {
    return apiError({ code: "FORBIDDEN", message: "仅管理员可操作", status: 403 });
  }

  const { id } = await params;

  try {
    const body = (await req.json()) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return apiError({ code: "BAD_REQUEST", message: "缺少 enabled 字段", status: 400 });
    }

    // 不允许禁用自己
    if (id === me.id && !body.enabled) {
      return apiError({ code: "BAD_REQUEST", message: "不能禁用当前登录的管理员账号", status: 400 });
    }

    const [updated] = await db
      .update(users)
      .set({ enabled: body.enabled })
      .where(eq(users.id, id))
      .returning({ id: users.id, name: users.name, enabled: users.enabled });

    if (!updated) {
      return apiError({ code: "NOT_FOUND", message: "用户不存在", status: 404 });
    }

    return apiOk(updated);
  } catch (e) {
    return apiError({
      code: "INTERNAL",
      message: `操作失败: ${(e as Error).message}`,
      status: 500,
    });
  }
}
