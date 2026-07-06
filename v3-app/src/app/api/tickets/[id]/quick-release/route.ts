import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  exceptionTickets,
  scanRecords,
  inventoryItems,
  inventoryMovements,
  approvalRecords,
  auditLogs,
} from "@/lib/db-schema";
import { eq, and, inArray } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { findExistingByKey } from "@/lib/idempotency";
import type { MovementType } from "@/types";

/**
 * POST /api/tickets/[id]/quick-release — 误判快速放行（§10.4 / 考点7）
 *
 * 仅 qc_supervisor 可操作。工单来源必须为 scan_qc。
 * 事务内：工单 → completed，扫描批次 → released，解锁库存，写审计日志。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  // 权限：仅品控主管
  if (!me.roleCodes.includes("qc_supervisor" as never)) {
    return apiError({ code: "FORBIDDEN", message: "仅品控主管可执行误判快速放行", status: 403 });
  }

  const { id: ticketId } = await params;
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || null;

  // 幂等
  if (idempotencyKey) {
    const existing = await findExistingByKey(idempotencyKey);
    if (existing && existing.ticketId === ticketId && existing.action === "quick_release") {
      return apiOk({ idempotent: true, approvalRecordId: existing.id });
    }
  }

  let body: { reason?: string; expectedVersion?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const reason = body.reason?.trim();
  if (!reason) {
    return apiError({ code: "BAD_REQUEST", message: "快速放行必须填写复核原因", status: 400 });
  }
  const expectedVersion = Number(body.expectedVersion);

  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, ticketId)).limit(1);
  if (!ticket) return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });

  // 来源校验
  if (ticket.source !== "scan_qc") {
    return apiError({ code: "FORBIDDEN", message: "仅品控工单（扫描触发）可快速放行", status: 403 });
  }

  // 状态校验：未关闭才可放行
  const CLOSED_STATUSES = ["completed", "closed", "auto_rejected_timeout", "closed_rejected_limit"];
  if (CLOSED_STATUSES.includes(ticket.status)) {
    return apiError({ code: "INVALID_STATE_TRANSITION", message: `工单已处于终态 ${ticket.status}，不可放行`, status: 409 });
  }

  // 乐观锁
  if (Number(expectedVersion) !== Number(ticket.version)) {
    return apiError({ code: "TICKET_VERSION_CONFLICT", message: "该工单已被其他人处理，请刷新后查看", status: 409 });
  }

  // 不能放行自己上报的工单（自批自核）
  if (ticket.reporterId && me.id === ticket.reporterId) {
    return apiError({ code: "FORBIDDEN", message: "不能快速放行自己上报的工单", status: 403 });
  }

  try {
    const approvalRecordId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      // 事务内再确认版本
      const [cur] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, ticketId)).limit(1);
      if (!cur) throw new Error("工单不存在");
      if (Number(cur.version) !== Number(expectedVersion)) {
        throw Object.assign(new Error("TICKET_VERSION_CONFLICT"), { code: "TICKET_VERSION_CONFLICT" });
      }

      // 写审批记录
      await tx.insert(approvalRecords).values({
        id: approvalRecordId,
        ticketId,
        approverId: me.id,
        level: 2,
        action: "quick_release",
        comment: reason,
        fromStatus: cur.status,
        toStatus: "completed",
        idempotencyKey: idempotencyKey ?? null,
      });

      // 工单 → completed
      await tx
        .update(exceptionTickets)
        .set({
          status: "completed",
          currentLevel: 0,
          version: Number(cur.version) + 1,
          lastActionAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exceptionTickets.id, ticketId));

      // 扫描批次 → released（批量更新）
      const scans = await tx
        .select()
        .from(scanRecords)
        .where(and(eq(scanRecords.ticketId, ticketId), eq(scanRecords.qcStatus, "qc_hold")))
        .execute();

      if (scans.length > 0) {
        // 1. 批量更新所有扫描记录状态为 released
        const scanIds = scans.map((s) => s.id);
        await tx
          .update(scanRecords)
          .set({ qcStatus: "released" })
          .where(inArray(scanRecords.id, scanIds));

        // 2. 批量查询所有涉及的库存项
        const skuBatchPairs = scans.map((s) => `${s.skuCode}|${s.batchNo}`);
        const uniquePairs = [...new Set(skuBatchPairs)];
        const inventoryRows: Array<{ inv: typeof inventoryItems.$inferSelect; unlockQty: number }> = [];

        for (const pair of uniquePairs) {
          const [skuCode, batchNo] = pair.split("|");
          const matchingScans = scans.filter((s) => s.skuCode === skuCode && s.batchNo === batchNo);
          const totalUnlockQty = matchingScans.reduce((sum, s) => sum + Number(s.actualQuantity), 0);
          const [inv] = await tx
            .select()
            .from(inventoryItems)
            .where(and(eq(inventoryItems.skuCode, skuCode), eq(inventoryItems.batchNo, batchNo)))
            .limit(1);
          if (inv) {
            inventoryRows.push({ inv, unlockQty: totalUnlockQty });
          }
        }

        // 3. 批量更新库存 + 收集流水数据
        const movementValues: Array<typeof inventoryMovements.$inferInsert> = [];
        for (const { inv, unlockQty } of inventoryRows) {
          const beforeAvail = Number(inv.availableQuantity);
          const beforeLocked = Number(inv.lockedQuantity);
          const afterLocked = Math.max(0, beforeLocked - unlockQty);
          await tx
            .update(inventoryItems)
            .set({ lockedQuantity: String(afterLocked), status: "normal", updatedAt: new Date() })
            .where(eq(inventoryItems.id, inv.id));

          movementValues.push({
            ticketId,
            approvalRecordId,
            skuCode: inv.skuCode,
            batchNo: inv.batchNo,
            movementType: "unlock" as MovementType,
            quantity: String(unlockQty),
            beforeSnapshot: { available: beforeAvail, locked: beforeLocked },
            afterSnapshot: { available: beforeAvail, locked: afterLocked },
          });
        }

        // 4. 批量插入库存流水
        if (movementValues.length > 0) {
          await tx.insert(inventoryMovements).values(movementValues);
        }
      }

      // 审计日志
      await tx.insert(auditLogs).values({
        actorId: me.id,
        targetType: "ticket",
        targetId: ticketId,
        action: "quick_release",
        detail: {
          ticketNo: cur.ticketNo,
          reason,
          approverName: me.name,
          scansReleased: scans.length,
        },
      });
    });

    return apiOk({
      ok: true,
      approvalRecordId,
      fromStatus: ticket.status,
      toStatus: "completed",
      message: "快速放行成功，批次已解锁",
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "TICKET_VERSION_CONFLICT") {
      return apiError({ code: "TICKET_VERSION_CONFLICT", message: "该工单已被其他人处理，请刷新后查看", status: 409 });
    }
    console.error("[quick-release] 失败:", e);
    return apiError({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e), status: 500 });
  }
}
