import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  exceptionTickets,
  approvalRecords,
  auditLogs,
  waybillSnapshots,
  waybillSkuSnapshots,
} from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { validateApprover, level1ApproveNextStatus } from "@/lib/approval-engine";
import { canTransition, assertCanApproveAtLevel } from "@/lib/state-machine";
import { findExistingByKey } from "@/lib/idempotency";
import { executeActions, exceedsThreshold as amtExceeds } from "@/lib/execution-engine";
import type { ExecutionAction } from "@/types";

/**
 * POST /api/tickets/[id]/approve — 审批通过（§10.3）
 * 头：Idempotency-Key
 * 入参：{ comment, expectedVersion, executionAction, level }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录或会话失效", status: 401 });

  const { id } = await params;
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || null;

  // 幂等：同 key 已存在 → 直接返回既有结果
  if (idempotencyKey) {
    const existing = await findExistingByKey(idempotencyKey);
    if (existing && existing.ticketId === id) {
      return apiOk({ idempotent: true, approvalRecordId: existing.id, action: existing.action });
    }
  }

  let body: { comment?: string; expectedVersion?: number; executionAction?: ExecutionAction; level?: 1 | 2 } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const expectedVersion = Number(body.expectedVersion);
  const executionAction = (body.executionAction ?? "pay_customer") as ExecutionAction;
  const comment = body.comment?.trim() ?? "";

  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
  if (!ticket) return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });

  // 乐观锁
  if (Number(expectedVersion) !== Number(ticket.version)) {
    return apiError({
      code: "TICKET_VERSION_CONFLICT",
      message: "该工单已被其他人处理，请刷新后查看最新状态",
      status: 409,
    });
  }

  const actionLevel: 1 | 2 = body.level ?? (ticket.currentLevel === 2 ? 2 : 1);

  // 审批人资质校验
  const v = validateApprover({
    user: me,
    ticketStatus: ticket.status as "level1_reviewing" | "level2_reviewing",
    ticketReporterId: ticket.reporterId ?? null,
    actionLevel,
  });
  if (!v.ok) return apiError({ code: "FORBIDDEN", message: v.reason ?? "无权限", status: 403 });

  // 状态匹配
  const ok = assertCanApproveAtLevel(ticket.status as "level1_reviewing" | "level2_reviewing", actionLevel);
  if (!ok.ok) return apiError({ code: "INVALID_STATE_TRANSITION", message: ok.reason ?? "状态不允许审批", status: 409 });

  // 计算下一状态
  const isHigh = ticket.severity === "high";
  const exceeds = amtExceeds(ticket.estimatedAmount) || isHigh;
  let nextStatus: "executing" | "level2_reviewing";
  if (actionLevel === 1) {
    nextStatus = level1ApproveNextStatus({ amountExceeds: exceeds, isHigh });
  } else {
    nextStatus = "executing";
  }

  if (!canTransition(ticket.status as never, nextStatus as never, "logistics")) {
    return apiError({ code: "INVALID_STATE_TRANSITION", message: `不允许 ${ticket.status} -> ${nextStatus}`, status: 409 });
  }

  try {
    const approvalRecordId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      // 乐观锁在事务内再做一次确认（防并发已 update）
      const [cur] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
      if (!cur) throw new Error("工单不存在");
      if (Number(cur.version) !== Number(expectedVersion)) {
        throw Object.assign(new Error("TICKET_VERSION_CONFLICT"), { code: "TICKET_VERSION_CONFLICT" });
      }

      await tx.insert(approvalRecords).values({
        id: approvalRecordId,
        ticketId: id,
        approverId: me.id,
        level: actionLevel,
        action: "approve",
        comment: comment || null,
        fromStatus: ticket.status,
        toStatus: nextStatus,
        idempotencyKey: idempotencyKey ?? null,
      });

      const newVersion = Number(cur.version) + 1;
      await tx
        .update(exceptionTickets)
        .set({
          status: nextStatus,
          currentLevel: nextStatus === "level2_reviewing" ? 2 : 0,
          version: newVersion,
          lastActionAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exceptionTickets.id, id));
    });

    // 若进入 executing，触发执行联动
    let execResult: Awaited<ReturnType<typeof executeActions>> | undefined;
    let finalStatus: "executing" | "level2_reviewing" | "completed" = nextStatus;
    if (nextStatus === "executing") {
      // 读取运单快照与首个 SKU
      const [snap] = ticket.waybillSnapshotId
        ? await db.select().from(waybillSnapshots).where(eq(waybillSnapshots.id, ticket.waybillSnapshotId)).limit(1)
        : [];
      const skuRows = ticket.waybillSnapshotId
        ? await db.select().from(waybillSkuSnapshots).where(eq(waybillSkuSnapshots.waybillSnapshotId, ticket.waybillSnapshotId))
        : [];
      const firstSku = skuRows[0] ?? null;

      if (!firstSku) {
        execResult = { ok: false, reason: "运单无 SKU 明细，跳过库存联动" };
      } else {
        const batchNo = snap?.batchId ?? "UNKNOWN-BATCH";
        execResult = await executeActions({
          ticketId: id,
          approvalRecordId,
          executionAction,
          actorId: me.id,
          skuCode: firstSku.skuCode,
          skuName: firstSku.skuName,
          batchNo,
          quantity: Number(firstSku.skuQuantity) || 1,
          compensationAmount: Number(ticket.estimatedAmount),
          counterpartyName: "运单客户",
          reason: ticket.description,
        });
      }

      if (execResult?.ok) {
        await db
          .update(exceptionTickets)
          .set({ status: "completed", lastActionAt: new Date(), updatedAt: new Date() })
          .where(eq(exceptionTickets.id, id));
        finalStatus = "completed";
      } else {
        // 执行失败：保留 executing 状态并写审计日志，待人工介入
        await db.insert(auditLogs).values({
          actorId: me.id,
          targetType: "ticket",
          targetId: id,
          action: "execute_failed",
          detail: { executionAction, reason: execResult?.reason ?? "未知原因" },
        });
      }
    }

    return apiOk({
      ok: true,
      approvalRecordId,
      fromStatus: ticket.status,
      toStatus: finalStatus,
      execution: execResult ?? null,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "TICKET_VERSION_CONFLICT") {
      return apiError({ code: "TICKET_VERSION_CONFLICT", message: "该工单已被其他人处理，请刷新后查看最新状态", status: 409 });
    }
    console.error("[approve] 失败:", e);
    return apiError({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e), status: 500 });
  }
}
