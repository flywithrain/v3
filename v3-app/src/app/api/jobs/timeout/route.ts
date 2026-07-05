import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  exceptionTickets,
  approvalRecords,
  scanRecords,
  auditLogs,
} from "@/lib/db-schema";
import { eq, and, lte, isNotNull } from "drizzle-orm";
import { apiOk, apiError } from "@/lib/auth";
import { canTransition } from "@/lib/state-machine";
import type { TicketStatus, ApprovalAction } from "@/types";

/**
 * POST /api/jobs/timeout — 超时自动流转任务（§10.5 / 考点3子项）
 *
 * 由 Vercel Cron 或手动触发。幂等：仅处理 due_at <= now 且非终态的工单。
 *
 * 处理：
 * - 一级审批超时 → 升级二级
 * - 二级审批超时 → auto_rejected_timeout
 * - 品控暂扣超时 → 强制升级二级（scan_records.hold_due_at）
 */
export async function POST(req: NextRequest) {
  // 简单鉴权：cron secret 或 admin
  const authHeader = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // 如果没有配 CRON_SECRET，允许本地手动触发
    const { getCurrentUser } = await import("@/lib/auth");
    const me = await getCurrentUser(req);
    if (!me || !me.roleCodes.includes("admin" as never)) {
      return apiError({ code: "UNAUTHORIZED", message: "无权触发超时任务", status: 401 });
    }
  }

  const now = new Date();
  let processed = 0;
  const results: Array<{ ticketId: string; action: string; from: string; to: string }> = [];

  // 1. 一级审批超时 → 升级二级
  const level1TimeoutTickets = await db
    .select()
    .from(exceptionTickets)
    .where(
      and(
        eq(exceptionTickets.status, "level1_reviewing"),
        isNotNull(exceptionTickets.dueAt),
        lte(exceptionTickets.dueAt, now)
      )
    )
    .execute();

  for (const ticket of level1TimeoutTickets) {
    if (!canTransition(ticket.status as TicketStatus, "level2_reviewing")) continue;
    try {
      const approvalRecordId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        const [cur] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, ticket.id)).limit(1);
        if (!cur || cur.status !== "level1_reviewing") return; // 幂等：状态已变

        await tx.insert(approvalRecords).values({
          id: approvalRecordId,
          ticketId: ticket.id,
          approverId: null,
          level: 1,
          action: "auto_escalate" as ApprovalAction,
          comment: "一级审批超时，自动升级二级",
          fromStatus: "level1_reviewing",
          toStatus: "level2_reviewing",
        });

        await tx
          .update(exceptionTickets)
          .set({
            status: "level2_reviewing",
            currentLevel: 2,
            version: Number(cur.version) + 1,
            dueAt: new Date(now.getTime() + 24 * 3600 * 1000), // 二级 24h
            lastActionAt: now,
            updatedAt: now,
          })
          .where(eq(exceptionTickets.id, ticket.id));

        await tx.insert(auditLogs).values({
          actorId: null,
          targetType: "ticket",
          targetId: ticket.id,
          action: "auto_escalate_level1_timeout",
          detail: { ticketNo: cur.ticketNo, from: "level1_reviewing", to: "level2_reviewing" },
        });
      });
      processed++;
      results.push({ ticketId: ticket.id, action: "level1_timeout_escalate", from: "level1_reviewing", to: "level2_reviewing" });
    } catch (e) {
      console.error(`[timeout] ticket ${ticket.id} 一级超时处理失败:`, e);
    }
  }

  // 2. 二级审批超时 → auto_rejected_timeout
  const level2TimeoutTickets = await db
    .select()
    .from(exceptionTickets)
    .where(
      and(
        eq(exceptionTickets.status, "level2_reviewing"),
        isNotNull(exceptionTickets.dueAt),
        lte(exceptionTickets.dueAt, now)
      )
    )
    .execute();

  for (const ticket of level2TimeoutTickets) {
    if (!canTransition(ticket.status as TicketStatus, "auto_rejected_timeout")) continue;
    try {
      const approvalRecordId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        const [cur] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, ticket.id)).limit(1);
        if (!cur || cur.status !== "level2_reviewing") return;

        await tx.insert(approvalRecords).values({
          id: approvalRecordId,
          ticketId: ticket.id,
          approverId: null,
          level: 2,
          action: "auto_reject" as ApprovalAction,
          comment: "二级审批超时，自动驳回",
          fromStatus: "level2_reviewing",
          toStatus: "auto_rejected_timeout",
        });

        await tx
          .update(exceptionTickets)
          .set({
            status: "auto_rejected_timeout",
            currentLevel: 0,
            version: Number(cur.version) + 1,
            lastActionAt: now,
            updatedAt: now,
          })
          .where(eq(exceptionTickets.id, ticket.id));

        await tx.insert(auditLogs).values({
          actorId: null,
          targetType: "ticket",
          targetId: ticket.id,
          action: "auto_reject_level2_timeout",
          detail: { ticketNo: cur.ticketNo, from: "level2_reviewing", to: "auto_rejected_timeout" },
        });
      });
      processed++;
      results.push({ ticketId: ticket.id, action: "level2_timeout_reject", from: "level2_reviewing", to: "auto_rejected_timeout" });
    } catch (e) {
      console.error(`[timeout] ticket ${ticket.id} 二级超时处理失败:`, e);
    }
  }

  // 3. 品控暂扣超时 → 强制升级二级（更新 scan_records + 关联工单）
  const holdTimeoutScans = await db
    .select()
    .from(scanRecords)
    .where(
      and(
        eq(scanRecords.qcStatus, "qc_hold"),
        isNotNull(scanRecords.holdDueAt),
        lte(scanRecords.holdDueAt, now)
      )
    )
    .execute();

  for (const scan of holdTimeoutScans) {
    if (!scan.ticketId) continue;
    try {
      await db.transaction(async (tx) => {
        // 更新扫描批次状态为 escalated
        const [curScan] = await tx.select().from(scanRecords).where(eq(scanRecords.id, scan.id)).limit(1);
        if (!curScan || curScan.qcStatus !== "qc_hold") return;

        await tx.update(scanRecords).set({ qcStatus: "escalated" }).where(eq(scanRecords.id, scan.id));

        // 如果关联工单还在 level2_reviewing，更新 due_at 提前
        const [ticket] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, scan.ticketId!)).limit(1);
        if (ticket && ticket.status === "level2_reviewing") {
          await tx
            .update(exceptionTickets)
            .set({ dueAt: new Date(now.getTime() + 4 * 3600 * 1000), lastActionAt: now, updatedAt: now })
            .where(eq(exceptionTickets.id, ticket.id));
        }

        await tx.insert(auditLogs).values({
          actorId: null,
          targetType: "ticket",
          targetId: scan.ticketId!,
          action: "qc_hold_timeout_escalate",
          detail: { scanNo: curScan.scanNo, batchNo: curScan.batchNo, skuCode: curScan.skuCode },
        });
      });
      processed++;
      results.push({ ticketId: scan.ticketId!, action: "qc_hold_timeout", from: "qc_hold", to: "escalated" });
    } catch (e) {
      console.error(`[timeout] scan ${scan.id} 暂扣超时处理失败:`, e);
    }
  }

  return apiOk({
    processed,
    checkedAt: now.toISOString(),
    details: results,
  });
}
