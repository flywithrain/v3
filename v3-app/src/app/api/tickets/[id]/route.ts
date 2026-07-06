import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  exceptionTickets,
  waybillSnapshots,
  waybillSkuSnapshots,
  approvalRecords,
  inventoryMovements,
  compensationRecords,
  auditLogs,
  users,
} from "@/lib/db-schema";
import { eq, desc, and } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";

/** GET /api/tickets/[id] — 工单详情（§11.5 子集） */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const { id } = await params;
  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
  if (!ticket) return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });

  // 运单快照 + SKU 明细
  let snapshot: typeof waybillSnapshots.$inferSelect | null = null;
  if (ticket.waybillSnapshotId) {
    const [s] = await db.select().from(waybillSnapshots).where(eq(waybillSnapshots.id, ticket.waybillSnapshotId)).limit(1);
    snapshot = s ?? null;
  }
  const skuItems = snapshot
    ? await db.select().from(waybillSkuSnapshots).where(eq(waybillSkuSnapshots.waybillSnapshotId, snapshot.id))
    : [];

  // 审批历史时间线（带审批人姓名）
  const approvalRows = await db
    .select({
      record: approvalRecords,
      approverName: users.name,
    })
    .from(approvalRecords)
    .leftJoin(users, eq(users.id, approvalRecords.approverId))
    .where(eq(approvalRecords.ticketId, id))
    .orderBy(desc(approvalRecords.createdAt));

  const approvalTimeline = approvalRows.map((r) => ({
    ...r.record,
    approverName: r.approverName ?? "(系统)",
  }));

  // 上报人姓名
  let reporterName: string | null = null;
  if (ticket.reporterId) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, ticket.reporterId)).limit(1);
    reporterName = u?.name ?? null;
  }

  // 当前审批人姓名 + 启用状态
  let assignedApproverName: string | null = null;
  let assignedApproverEnabled: boolean | null = null;
  if (ticket.assignedApproverId) {
    const [appr] = await db.select({ name: users.name, enabled: users.enabled }).from(users).where(eq(users.id, ticket.assignedApproverId)).limit(1);
    assignedApproverName = appr?.name ?? null;
    assignedApproverEnabled = appr?.enabled ?? null;
  }

  // 库存流水
  const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.ticketId, id)).orderBy(desc(inventoryMovements.createdAt));

  // 赔付记录
  const compensations = await db.select().from(compensationRecords).where(eq(compensationRecords.ticketId, id)).orderBy(desc(compensationRecords.createdAt));

  // 审计日志（仅本工单，SQL 层过滤 targetId 避免全表扫描后内存过滤）
  const ticketAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.targetType, "ticket"), eq(auditLogs.targetId, id)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);

  return apiOk({
    ticket: { ...ticket, reporterName, assignedApproverName, assignedApproverEnabled },
    snapshot,
    snapshotSyncedAt: snapshot ? snapshot.sourceSyncedAt : null,
    isLiveFromV2: snapshot ? isRecent(snapshot.sourceSyncedAt) : false, // 60s 内视为实时
    skuItems,
    approvalTimeline,
    movements,
    compensations,
    audits: ticketAudits,
    canApprove: canUserApprove(me, ticket),
  });
}

function canUserApprove(me: { id: string; roleCodes: string[] }, ticket: { reporterId: string | null; status: string; currentLevel: number | null }): {
  level1: boolean;
  level2: boolean;
} {
  if (ticket.reporterId === me.id) return { level1: false, level2: false };
  const isL1 = me.roleCodes.includes("level1_approver") || me.roleCodes.includes("admin");
  const isL2 = me.roleCodes.includes("level2_approver") || me.roleCodes.includes("admin");
  return {
    level1: isL1 && ticket.status === "level1_reviewing",
    level2: isL2 && ticket.status === "level2_reviewing",
  };
}

function isRecent(d: Date | null): boolean {
  if (!d) return false;
  return Date.now() - new Date(d).getTime() < 60 * 1000;
}
