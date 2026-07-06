import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { approvalRules, auditLogs } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError, requireRoles } from "@/lib/auth";
import type { RoleCode } from "@/types";

/** DELETE /api/rules/approval/[id] — 删除审批规则（仅 admin） */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  const forbidden = requireRoles(me, "admin" as RoleCode);
  if (forbidden) return forbidden;

  const { id } = await params;

  const [existing] = await db.select().from(approvalRules).where(eq(approvalRules.id, id));
  if (!existing) {
    return apiError({ code: "NOT_FOUND", message: "规则不存在", status: 404 });
  }

  await db.delete(approvalRules).where(eq(approvalRules.id, id));

  await db.insert(auditLogs).values({
    actorId: me!.id,
    targetType: "rule",
    targetId: id,
    action: "rule_delete",
    detail: { name: existing.name, category: existing.category },
  });

  return apiOk({ id, deleted: true });
}
