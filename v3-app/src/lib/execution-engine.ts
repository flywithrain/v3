import { db } from "@/lib/db";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "@/lib/db-schema";
import { compensationRecords, inventoryItems, inventoryMovements, auditLogs } from "@/lib/db-schema";
import { eq, and } from "drizzle-orm";
import type { ExecutionAction, MovementType, CompensationDirection } from "@/types";
import { actionNeedsOutbound, actionNeedsReturnIn, actionNeedsPayCustomer } from "@/lib/state-machine";

/**
 * 执行联动引擎：审批通过后，在【同一数据库事务】内生成赔付记录与库存流水，并更新库存。
 * §13.3 事务要求；§12.1 物流动作映射；§12 要求关联 approval_record_id 且不得重复生成。
 *
 * 使用 drizzle-orm/neon-serverless 的 db.transaction()，回调内提供事务作用域 tx。
 */

const AMOUNT_THRESHOLD = 1000; // §6.1

export function exceedsThreshold(amount: string | number | null): boolean {
  const n = Number(amount ?? 0);
  return Number.isFinite(n) && n > AMOUNT_THRESHOLD;
}

type TxDb = NeonDatabase<typeof schema>;

export interface ExecuteInput {
  ticketId: string;
  approvalRecordId: string;
  executionAction: ExecutionAction;
  actorId: string;
  skuCode: string;
  skuName?: string;
  batchNo: string;
  quantity?: number;
  compensationAmount?: number;
  counterpartyName?: string;
  reason?: string;
}

export interface ExecuteResult {
  ok: boolean;
  compensationId?: string;
  movementIds?: string[];
  reason?: string;
}

export async function executeActions(input: ExecuteInput): Promise<ExecuteResult> {
  try {
    const result = await db.transaction(
      async (tx) => {
        // 幂等：同一 approval_record_id 不得重复生成赔付/库存流水
        const existingComp = await tx
          .select({ id: compensationRecords.id })
          .from(compensationRecords)
          .where(eq(compensationRecords.approvalRecordId, input.approvalRecordId))
          .limit(1);
        if (existingComp.length > 0) {
          return { ok: true, reason: "该审批记录已生成过执行结果，幂等跳过" } as ExecuteResult;
        }

        const movementIds: string[] = [];
        let compensationId: string | undefined;

        // 赔付记录
        if (actionNeedsPayCustomer(input.executionAction)) {
          const amount = Number(input.compensationAmount ?? 0);
          const [comp] = await tx
            .insert(compensationRecords)
            .values({
              ticketId: input.ticketId,
              approvalRecordId: input.approvalRecordId,
              direction: "pay_customer" as CompensationDirection,
              amount: String(amount),
              status: "recorded",
              counterpartyName: input.counterpartyName ?? null,
              reason: input.reason ?? null,
            })
            .returning({ id: compensationRecords.id });
          compensationId = comp?.id;
        }

        const qty = Number(input.quantity ?? 1);

        // 出库（重发）
        if (actionNeedsOutbound(input.executionAction)) {
          await applyOutbound(tx, input, qty, movementIds);
        }

        // 退货入库
        if (actionNeedsReturnIn(input.executionAction)) {
          await applyReturnIn(tx, input, qty, movementIds);
        }

        // 审计日志
        await tx.insert(auditLogs).values({
          actorId: input.actorId,
          targetType: "ticket",
          targetId: input.ticketId,
          action: `execute_${input.executionAction}`,
          detail: {
            executionAction: input.executionAction,
            approvalRecordId: input.approvalRecordId,
            compensationId: compensationId ?? null,
            movementIds,
            skuCode: input.skuCode,
            batchNo: input.batchNo,
            quantity: qty,
          },
        });

        return { ok: true, compensationId, movementIds } as ExecuteResult;
      },
      { isolationLevel: "read committed", accessMode: "read write" }
    );

    return result;
  } catch (e) {
    console.error("[execution] 事务失败:", e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function applyOutbound(tx: TxDb, input: ExecuteInput, qty: number, movementIds: string[]) {
  const before = await tx
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.skuCode, input.skuCode), eq(inventoryItems.batchNo, input.batchNo)))
    .limit(1);
  const beforeRow = before[0] ?? null;
  const beforeAvail = Number(beforeRow?.availableQuantity ?? 0);
  const beforeLocked = Number(beforeRow?.lockedQuantity ?? 0);
  const afterAvail = Math.max(0, beforeAvail - qty);

  if (beforeRow) {
    await tx.update(inventoryItems).set({ availableQuantity: String(afterAvail), updatedAt: new Date() }).where(eq(inventoryItems.id, beforeRow.id));
  } else {
    await tx.insert(inventoryItems).values({
      skuCode: input.skuCode,
      skuName: input.skuName ?? null,
      batchNo: input.batchNo,
      availableQuantity: String(-qty),
      lockedQuantity: "0",
      status: "normal",
    });
  }

  const [mv] = await tx
    .insert(inventoryMovements)
    .values({
      ticketId: input.ticketId,
      approvalRecordId: input.approvalRecordId,
      skuCode: input.skuCode,
      batchNo: input.batchNo,
      movementType: "outbound" as MovementType,
      quantity: String(qty),
      beforeSnapshot: { available: beforeAvail, locked: beforeLocked },
      afterSnapshot: { available: afterAvail, locked: beforeLocked },
    })
    .returning({ id: inventoryMovements.id });
  if (mv?.id) movementIds.push(mv.id);
}

async function applyReturnIn(tx: TxDb, input: ExecuteInput, qty: number, movementIds: string[]) {
  const before = await tx
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.skuCode, input.skuCode), eq(inventoryItems.batchNo, input.batchNo)))
    .limit(1);
  const beforeRow = before[0] ?? null;
  const beforeAvail = Number(beforeRow?.availableQuantity ?? 0);
  const beforeLocked = Number(beforeRow?.lockedQuantity ?? 0);
  const afterAvail = beforeAvail + qty;

  if (beforeRow) {
    await tx.update(inventoryItems).set({ availableQuantity: String(afterAvail), status: "returned", updatedAt: new Date() }).where(eq(inventoryItems.id, beforeRow.id));
  } else {
    await tx.insert(inventoryItems).values({
      skuCode: input.skuCode,
      skuName: input.skuName ?? null,
      batchNo: input.batchNo,
      availableQuantity: String(afterAvail),
      lockedQuantity: "0",
      status: "returned",
    });
  }

  const [mv] = await tx
    .insert(inventoryMovements)
    .values({
      ticketId: input.ticketId,
      approvalRecordId: input.approvalRecordId,
      skuCode: input.skuCode,
      batchNo: input.batchNo,
      movementType: "return_in" as MovementType,
      quantity: String(qty),
      beforeSnapshot: { available: beforeAvail, locked: beforeLocked },
      afterSnapshot: { available: afterAvail, locked: beforeLocked },
    })
    .returning({ id: inventoryMovements.id });
  if (mv?.id) movementIds.push(mv.id);
}

export function requiresCompensationAmount(action: ExecutionAction): boolean {
  return action === "pay_customer" || action === "pay_customer_and_reship";
}
