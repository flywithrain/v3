import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { qcRules, auditLogs } from "@/lib/db-schema";
import { eq, asc } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError, requireRoles } from "@/lib/auth";
import type { RoleCode } from "@/types";

/** GET /api/rules/qc — 列出品控规则 */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const rows = await db.select().from(qcRules).orderBy(asc(qcRules.priority));
  return apiOk(rows);
}

/** POST /api/rules/qc — 新增或更新品控规则（仅 admin） */
export async function POST(req: NextRequest) {
  const me = await getCurrentUser(req);
  const forbidden = requireRoles(me, "admin" as RoleCode);
  if (forbidden) return forbidden;

  let body: {
    id?: string;
    name?: string;
    subtype?: string;
    conditionType?: string;
    conditionConfig?: unknown;
    severity?: string;
    autoCreateTicket?: boolean;
    defaultApprovalLevel?: number;
    enabled?: boolean;
    priority?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body.name?.trim() || !body.subtype?.trim() || !body.conditionType?.trim() || !body.severity?.trim()) {
    return apiError({ code: "BAD_REQUEST", message: "需提供 name、subtype、conditionType、severity", status: 400 });
  }
  if (!["low", "medium", "high"].includes(body.severity)) {
    return apiError({ code: "BAD_REQUEST", message: "severity 需为 low/medium/high", status: 400 });
  }

  if (body.id) {
    await db
      .update(qcRules)
      .set({
        name: body.name,
        subtype: body.subtype,
        conditionType: body.conditionType,
        conditionConfig: body.conditionConfig ?? {},
        severity: body.severity,
        autoCreateTicket: body.autoCreateTicket ?? true,
        defaultApprovalLevel: body.defaultApprovalLevel ?? 2,
        enabled: body.enabled ?? true,
        priority: Number(body.priority ?? 100),
        updatedAt: new Date(),
      })
      .where(eq(qcRules.id, body.id));
    await db.insert(auditLogs).values({
      actorId: me!.id,
      targetType: "rule",
      targetId: body.id,
      action: "qc_rule_update",
      detail: { name: body.name, subtype: body.subtype, conditionType: body.conditionType, severity: body.severity },
    });
    return apiOk({ id: body.id, updated: true });
  }

  const [created] = await db
    .insert(qcRules)
    .values({
      name: body.name,
      subtype: body.subtype,
      conditionType: body.conditionType,
      conditionConfig: body.conditionConfig ?? {},
      severity: body.severity,
      autoCreateTicket: body.autoCreateTicket ?? true,
      defaultApprovalLevel: body.defaultApprovalLevel ?? 2,
      enabled: body.enabled ?? true,
      priority: Number(body.priority ?? 100),
    })
    .returning({ id: qcRules.id });

  await db.insert(auditLogs).values({
    actorId: me!.id,
    targetType: "rule",
    targetId: created?.id ?? "",
    action: "qc_rule_create",
    detail: { name: body.name, subtype: body.subtype, conditionType: body.conditionType, severity: body.severity },
  });

  return apiOk({ id: created?.id, created: true });
}
