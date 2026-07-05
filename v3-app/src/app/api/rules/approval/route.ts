import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { approvalRules } from "@/lib/db-schema";
import { eq, asc } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError, requireRoles } from "@/lib/auth";
import { auditLogs } from "@/lib/db-schema";
import type { RoleCode } from "@/types";

/** GET /api/rules/approval — 列出审批规则 */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const rows = await db.select().from(approvalRules).orderBy(asc(approvalRules.priority));
  return apiOk(rows);
}

/** POST /api/rules/approval — 新增或更新审批规则（仅 admin） */
export async function POST(req: NextRequest) {
  const me = await getCurrentUser(req);
  const forbidden = requireRoles(me, "admin" as RoleCode);
  if (forbidden) return forbidden;

  let body: {
    id?: string;
    name?: string;
    category?: string;
    conditionConfig?: unknown;
    targetLevel?: number;
    timeoutHours?: number | null;
    enabled?: boolean;
    priority?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body.name?.trim() || !body.category?.trim() || body.targetLevel === undefined) {
    return apiError({ code: "BAD_REQUEST", message: "需提供 name、category、targetLevel", status: 400 });
  }
  if (![1, 2].includes(Number(body.targetLevel))) {
    return apiError({ code: "BAD_REQUEST", message: "targetLevel 仅支持 1 或 2", status: 400 });
  }

  if (body.id) {
    await db
      .update(approvalRules)
      .set({
        name: body.name,
        category: body.category,
        conditionConfig: body.conditionConfig ?? {},
        targetLevel: Number(body.targetLevel),
        timeoutHours: body.timeoutHours ?? null,
        enabled: body.enabled ?? true,
        priority: Number(body.priority ?? 100),
        updatedAt: new Date(),
      })
      .where(eq(approvalRules.id, body.id));
    await db.insert(auditLogs).values({
      actorId: me!.id,
      targetType: "rule",
      targetId: body.id,
      action: "rule_update",
      detail: { name: body.name, category: body.category, targetLevel: body.targetLevel },
    });
    return apiOk({ id: body.id, updated: true });
  }

  const [created] = await db
    .insert(approvalRules)
    .values({
      name: body.name,
      category: body.category,
      conditionConfig: body.conditionConfig ?? {},
      targetLevel: Number(body.targetLevel),
      timeoutHours: body.timeoutHours ?? null,
      enabled: body.enabled ?? true,
      priority: Number(body.priority ?? 100),
    })
    .returning({ id: approvalRules.id });

  await db.insert(auditLogs).values({
    actorId: me!.id,
    targetType: "rule",
    targetId: created?.id ?? "",
    action: "rule_create",
    detail: { name: body.name, category: body.category, targetLevel: body.targetLevel },
  });

  return apiOk({ id: created?.id, created: true });
}
