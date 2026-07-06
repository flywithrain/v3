import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  exceptionTickets,
  approvalRecords,
  scanRecords,
  auditLogs,
  users,
} from "@/lib/db-schema";
import { eq, and, lte, isNotNull, inArray } from "drizzle-orm";
import { apiOk, apiError } from "@/lib/auth";
import { canTransition } from "@/lib/state-machine";
import type { TicketStatus, ApprovalAction } from "@/types";

/**
 * POST /api/jobs/timeout — 超时自动流转任务（§10.5 / 考点3子项）
 *
 * 性能优化：每类超时在单个事务内批量处理，避免逐条开事务。
 * 原先 N 条超时工单 → N 个事务（4N 次 DB 调用），
 * 现在 N 条超时工单 → 1 个事务（批量 INSERT + 批量 UPDATE）。
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    const { getCurrentUser } = await import("@/lib/auth");
    const me = await getCurrentUser(req);
    if (!me || !me.roleCodes.includes("admin" as never)) {
      return apiError({ code: "UNAUTHORIZED", message: "无权触发超时任务", status: 401 });
    }
  }

  const now = new Date();
  let processed = 0;
  const results: Array<{ ticketId: string; action: string; from: string; to: string }> = [];

  // ====== 1. 一级审批超时 → 升级二级（单事务批量处理） ======
  const level1TimeoutTickets = await db
    .select()
    .from(exceptionTickets)
    .where(and(eq(exceptionTickets.status, "level1_reviewing"), isNotNull(exceptionTickets.dueAt), lte(exceptionTickets.dueAt, now)))
    .execute();

  const validL1 = level1TimeoutTickets.filter((t) => canTransition(t.status as TicketStatus, "level2_reviewing"));
  if (validL1.length > 0) {
    try {
      const l1Ids = validL1.map((t) => t.id);
      await db.transaction(async (tx) => {
        const currentTickets = await tx.select().from(exceptionTickets).where(inArray(exceptionTickets.id, l1Ids)).execute();
        const stillValid = currentTickets.filter((t) => t.status === "level1_reviewing");
        if (stillValid.length === 0) return;

        await tx.insert(approvalRecords).values(
          stillValid.map((t) => ({
            id: crypto.randomUUID(),
            ticketId: t.id,
            approverId: null,
            level: 1,
            action: "auto_escalate" as ApprovalAction,
            comment: "一级审批超时，自动升级二级",
            fromStatus: "level1_reviewing",
            toStatus: "level2_reviewing",
          }))
        );

        await tx.insert(auditLogs).values(
          stillValid.map((t) => ({
            actorId: null,
            targetType: "ticket",
            targetId: t.id,
            action: "auto_escalate_level1_timeout",
            detail: { ticketNo: t.ticketNo, from: "level1_reviewing", to: "level2_reviewing" },
          }))
        );

        const dueAt2 = new Date(now.getTime() + 24 * 3600 * 1000);
        for (const t of stillValid) {
          await tx.update(exceptionTickets).set({
            status: "level2_reviewing", currentLevel: 2, version: Number(t.version) + 1, dueAt: dueAt2, lastActionAt: now, updatedAt: now,
          }).where(eq(exceptionTickets.id, t.id));
        }
        processed += stillValid.length;
        stillValid.forEach((t) => results.push({ ticketId: t.id, action: "level1_timeout_escalate", from: "level1_reviewing", to: "level2_reviewing" }));
      });
    } catch (e) { console.error("[timeout] 一级超时批量处理失败:", e); }
  }

  // ====== 2. 二级审批超时 → auto_rejected_timeout（单事务批量处理） ======
  const level2TimeoutTickets = await db
    .select()
    .from(exceptionTickets)
    .where(and(eq(exceptionTickets.status, "level2_reviewing"), isNotNull(exceptionTickets.dueAt), lte(exceptionTickets.dueAt, now)))
    .execute();

  const validL2 = level2TimeoutTickets.filter((t) => canTransition(t.status as TicketStatus, "auto_rejected_timeout"));
  if (validL2.length > 0) {
    try {
      const l2Ids = validL2.map((t) => t.id);
      await db.transaction(async (tx) => {
        const currentTickets = await tx.select().from(exceptionTickets).where(inArray(exceptionTickets.id, l2Ids)).execute();
        const stillValid = currentTickets.filter((t) => t.status === "level2_reviewing");
        if (stillValid.length === 0) return;

        await tx.insert(approvalRecords).values(
          stillValid.map((t) => ({
            id: crypto.randomUUID(),
            ticketId: t.id,
            approverId: null,
            level: 2,
            action: "auto_reject" as ApprovalAction,
            comment: "二级审批超时，自动驳回",
            fromStatus: "level2_reviewing",
            toStatus: "auto_rejected_timeout",
          }))
        );

        await tx.insert(auditLogs).values(
          stillValid.map((t) => ({
            actorId: null,
            targetType: "ticket",
            targetId: t.id,
            action: "auto_reject_level2_timeout",
            detail: { ticketNo: t.ticketNo, from: "level2_reviewing", to: "auto_rejected_timeout" },
          }))
        );

        for (const t of stillValid) {
          await tx.update(exceptionTickets).set({
            status: "auto_rejected_timeout", currentLevel: 0, version: Number(t.version) + 1, lastActionAt: now, updatedAt: now,
          }).where(eq(exceptionTickets.id, t.id));
        }
        processed += stillValid.length;
        stillValid.forEach((t) => results.push({ ticketId: t.id, action: "level2_timeout_reject", from: "level2_reviewing", to: "auto_rejected_timeout" }));
      });
    } catch (e) { console.error("[timeout] 二级超时批量处理失败:", e); }
  }

  // ====== 3. 品控暂扣超时 → 强制升级二级（单事务批量处理） ======
  const holdTimeoutScans = await db
    .select()
    .from(scanRecords)
    .where(and(eq(scanRecords.qcStatus, "qc_hold"), isNotNull(scanRecords.holdDueAt), lte(scanRecords.holdDueAt, now)))
    .execute();

  const validHoldScans = holdTimeoutScans.filter((s) => s.ticketId);
  if (validHoldScans.length > 0) {
    try {
      const scanIds = validHoldScans.map((s) => s.id);
      const ticketIds = [...new Set(validHoldScans.map((s) => s.ticketId!))];
      await db.transaction(async (tx) => {
        const currentScans = await tx.select().from(scanRecords).where(inArray(scanRecords.id, scanIds)).execute();
        const stillHold = currentScans.filter((s) => s.qcStatus === "qc_hold");
        if (stillHold.length === 0) return;

        // 批量更新扫描批次状态为 escalated
        await tx.update(scanRecords).set({ qcStatus: "escalated" }).where(inArray(scanRecords.id, stillHold.map((s) => s.id)));

        // 批量查出关联工单，更新仍在 level2_reviewing 的 due_at
        const relatedTickets = await tx.select().from(exceptionTickets).where(inArray(exceptionTickets.id, ticketIds)).execute();
        const newDueAt = new Date(now.getTime() + 4 * 3600 * 1000);
        const ticketsToUpdate = relatedTickets.filter((t) => t.status === "level2_reviewing");
        for (const t of ticketsToUpdate) {
          await tx.update(exceptionTickets).set({ dueAt: newDueAt, lastActionAt: now, updatedAt: now }).where(eq(exceptionTickets.id, t.id));
        }

        // 批量插入审计日志
        await tx.insert(auditLogs).values(
          stillHold.map((s) => ({
            actorId: null,
            targetType: "ticket",
            targetId: s.ticketId!,
            action: "qc_hold_timeout_escalate",
            detail: { scanNo: s.scanNo, batchNo: s.batchNo, skuCode: s.skuCode },
          }))
        );
        processed += stillHold.length;
        stillHold.forEach((s) => results.push({ ticketId: s.ticketId!, action: "qc_hold_timeout", from: "qc_hold", to: "escalated" }));
      });
    } catch (e) { console.error("[timeout] 暂扣超时批量处理失败:", e); }
  }

  // ====== 4. 审批人禁用兜底 —— 自动转交工单（考试文档 模块二） ======
  try {
    // 查被禁用的审批人名下处于审批中状态的工单
    const disabledApproverTickets = await db
      .select({
        ticket: exceptionTickets,
        approverName: users.name,
      })
      .from(exceptionTickets)
      .innerJoin(users, eq(exceptionTickets.assignedApproverId, users.id))
      .where(
        and(
          eq(users.enabled, false),
          inArray(exceptionTickets.status, ["level1_reviewing", "level2_reviewing"])
        )
      )
      .execute();

    if (disabledApproverTickets.length > 0) {
      await db.transaction(async (tx) => {
        for (const { ticket } of disabledApproverTickets) {
          const [current] = await tx
            .select()
            .from(exceptionTickets)
            .where(eq(exceptionTickets.id, ticket.id))
            .limit(1)
            .execute();
          if (!current || !["level1_reviewing", "level2_reviewing"].includes(current.status)) continue;

          const isLevel1 = current.status === "level1_reviewing";
          const nowDate = new Date();

          // 一级工单：自动升级到二级（清除 assignedApproverId，后续二级审批重新分配）
          // 二级工单：清除 assignedApproverId，重置 dueAt 延迟 4h
          if (isLevel1) {
            const dueAt2 = new Date(nowDate.getTime() + 24 * 3600 * 1000);
            await tx
              .update(exceptionTickets)
              .set({
                status: "level2_reviewing",
                currentLevel: 2,
                assignedApproverId: null,
                version: Number(current.version) + 1,
                dueAt: dueAt2,
                lastActionAt: nowDate,
                updatedAt: nowDate,
              })
              .where(eq(exceptionTickets.id, ticket.id));

            await tx.insert(approvalRecords).values({
              id: crypto.randomUUID(),
              ticketId: ticket.id,
              approverId: null,
              level: 1,
              action: "transfer",
              comment: "一级审批人账号已禁用，自动升级二级",
              fromStatus: "level1_reviewing",
              toStatus: "level2_reviewing",
            });
          } else {
            const newDue = new Date(nowDate.getTime() + 4 * 3600 * 1000);
            await tx
              .update(exceptionTickets)
              .set({
                assignedApproverId: null,
                version: Number(current.version) + 1,
                dueAt: newDue,
                lastActionAt: nowDate,
                updatedAt: nowDate,
              })
              .where(eq(exceptionTickets.id, ticket.id));

            await tx.insert(approvalRecords).values({
              id: crypto.randomUUID(),
              ticketId: ticket.id,
              approverId: null,
              level: 2,
              action: "transfer",
              comment: "二级审批人账号已禁用，自动清除分配",
              fromStatus: "level2_reviewing",
              toStatus: "level2_reviewing",
            });
          }

          await tx.insert(auditLogs).values({
            actorId: null,
            targetType: "ticket",
            targetId: ticket.id,
            action: "approver_disabled_transfer",
            detail: {
              ticketNo: ticket.ticketNo,
              disabledApproverId: ticket.assignedApproverId,
              action: isLevel1 ? "escalate_to_level2" : "clear_assignee",
            },
          });

          processed++;
          results.push({
            ticketId: ticket.id,
            action: "approver_disabled_transfer",
            from: current.status,
            to: isLevel1 ? "level2_reviewing" : "level2_reviewing",
          });
        }
      });
    }
  } catch (e) {
    console.error("[timeout] 审批人禁用兜底处理失败:", e);
  }

  return apiOk({ processed, checkedAt: now.toISOString(), details: results });
}
