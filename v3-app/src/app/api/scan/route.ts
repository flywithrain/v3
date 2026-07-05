import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  scanRecords,
  exceptionTickets,
  waybillSnapshots,
  waybillSkuSnapshots,
  inventoryItems,
  inventoryMovements,
  auditLogs,
} from "@/lib/db-schema";
import { eq, and, inArray } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { v2Lookup, v2ValidateSku, V2ClientError } from "@/lib/v2-client";
import { evaluateQcRules, calcHoldDueAt } from "@/lib/qc-engine";
import { routeApproval, initialStatusForLevel } from "@/lib/approval-engine";
import { generateTicketNo } from "@/lib/utils";
import type { ApiException, Severity, MovementType } from "@/types";

/**
 * POST /api/scan — 扫描录入 + 品控规则检测（§10.1 / 考点7）
 *
 * 流程：
 * 1. 鉴权（warehouse_operator / qc_supervisor / admin）
 * 2. 调 V2 校验运单存在 + SKU 归属
 * 3. 刷新本地快照
 * 4. 执行品控规则引擎
 * 5. 通过 → 写 scan_records(qc_passed)，不创建工单
 * 6. 异常 → 检查同批次同SKU是否已有未关闭品控工单（扫描幂等）
 *    - 已有 → 只追加 scan_records，返回已有 ticketId
 *    - 无 → 事务内：锁定库存 + 创建工单 + 写 scan_records + 写审计日志
 */
export async function POST(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const allowed = ["warehouse_operator", "qc_supervisor", "admin"];
  if (!allowed.some((r) => me.roleCodes.includes(r as never))) {
    return apiError({ code: "FORBIDDEN", message: "当前角色无权执行扫描操作", status: 403 });
  }

  let body: {
    shipmentId?: string;
    externalCode?: string;
    skuCode?: string;
    actualQuantity?: number;
    skuSpec?: string;
    batchNo?: string;
    deviceId?: string;
    description?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { shipmentId, externalCode, skuCode, actualQuantity, skuSpec, batchNo, deviceId, description } = body;
  if ((!shipmentId?.trim() && !externalCode?.trim()) || !skuCode?.trim() || !batchNo?.trim()) {
    return apiError({ code: "BAD_REQUEST", message: "需提供 shipmentId/externalCode、skuCode、batchNo", status: 400 });
  }

  // 1. 调 V2 校验运单存在
  let v2Detail: Awaited<ReturnType<typeof v2Lookup>>["data"];
  let v2RequestId = "N/A";
  try {
    const r = await v2Lookup({ shipmentId: shipmentId?.trim(), externalCode: externalCode?.trim() });
    v2RequestId = r.requestId;
    v2Detail = r.data;
  } catch (e) {
    if (e instanceof V2ClientError && e.code === "V2_UNAVAILABLE") {
      return apiError({ code: "V2_UNAVAILABLE", message: "V2 不可用，无法实时校验，禁止扫描", status: 503 });
    }
    throw e;
  }
  if (!v2Detail) {
    return apiError({ code: "WAYBILL_NOT_FOUND", message: `V2 未找到该运单（requestId=${v2RequestId}）`, status: 404 } as ApiException);
  }

  // 2. 调 V2 校验 SKU 归属
  let v2Sku: Awaited<ReturnType<typeof v2ValidateSku>>["data"] = null;
  let v2SkuRequestId = "N/A";
  try {
    const sr = await v2ValidateSku(v2Detail.id, skuCode!.trim());
    v2SkuRequestId = sr.requestId;
    v2Sku = sr.data;
  } catch (e) {
    if (e instanceof V2ClientError && e.code === "V2_UNAVAILABLE") {
      return apiError({ code: "V2_UNAVAILABLE", message: "V2 不可用，无法校验 SKU 归属", status: 503 });
    }
    throw e;
  }
  if (!v2Sku || !v2Sku.valid) {
    return apiError({ code: "SKU_NOT_BELONG", message: `SKU ${skuCode} 不属于运单 ${v2Detail.externalCode ?? v2Detail.id}`, status: 400 } as ApiException);
  }

  // 3. 刷新本地快照（upsert）
  const now = new Date();
  const snapId = crypto.randomUUID();
  await db
    .insert(waybillSnapshots)
    .values({
      id: snapId,
      v2ShipmentId: v2Detail.id,
      externalCode: v2Detail.externalCode ?? null,
      storeName: v2Detail.storeName ?? null,
      receiverName: v2Detail.receiverName ?? null,
      receiverPhoneMasked: v2Detail.receiverPhone ?? null,
      receiverAddressSummary: v2Detail.receiverAddress ?? null,
      remark: v2Detail.remark ?? null,
      skuCount: v2Detail.skuCount ?? (v2Detail.items?.length ?? 0),
      totalQuantity: v2Detail.totalQuantity ?? "0",
      amount: "0",
      batchId: v2Detail.batchId ?? null,
      rawPayload: v2Detail,
      sourceSyncedAt: now,
      sourceVersion: "v1",
    })
    .onConflictDoUpdate({
      target: waybillSnapshots.v2ShipmentId,
      set: {
        externalCode: v2Detail.externalCode ?? null,
        storeName: v2Detail.storeName ?? null,
        rawPayload: v2Detail,
        sourceSyncedAt: now,
        updatedAt: now,
      },
    });

  const [snapRow] = await db.select({ id: waybillSnapshots.id }).from(waybillSnapshots).where(eq(waybillSnapshots.v2ShipmentId, v2Detail.id)).limit(1);
  const finalSnapId = snapRow?.id ?? snapId;

  // 刷新 SKU 快照
  await db.delete(waybillSkuSnapshots).where(eq(waybillSkuSnapshots.waybillSnapshotId, finalSnapId));
  if (v2Detail.items && v2Detail.items.length > 0) {
    await db.insert(waybillSkuSnapshots).values(
      v2Detail.items.map((it) => ({
        waybillSnapshotId: finalSnapId,
        v2OrderId: it.id ?? null,
        skuCode: it.skuCode,
        skuName: it.skuName,
        skuQuantity: it.skuQuantity,
        skuSpec: it.skuSpec ?? null,
        rawPayload: it,
        sourceSyncedAt: now,
      }))
    );
  }

  // 4. 执行品控规则引擎
  const expectedQty = Number(v2Sku.skuQuantity ?? 0);
  const actualQty = Number(actualQuantity ?? 0);
  const qcResult = await evaluateQcRules({
    expectedQuantity: expectedQty,
    actualQuantity: actualQty,
    expectedSpec: v2Sku.skuSpec ?? null,
    actualSpec: skuSpec?.trim() ?? null,
    expectedSkuCode: skuCode!.trim(),
    actualSkuCode: skuCode!.trim(),
    batchNo: batchNo!.trim(),
    description: description ?? "",
  });

  const scanNo = `SCAN-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // 5. 品控通过
  if (qcResult.passed) {
    const [scan] = await db
      .insert(scanRecords)
      .values({
        scanNo,
        waybillSnapshotId: finalSnapId,
        v2ShipmentId: v2Detail.id,
        skuCode: skuCode!.trim(),
        skuName: v2Sku.skuName ?? null,
        skuSpec: v2Sku.skuSpec ?? null,
        expectedQuantity: String(expectedQty),
        actualQuantity: String(actualQty),
        batchNo: batchNo!.trim(),
        operatorId: me.id,
        deviceId: deviceId ?? null,
        qcResult: "passed",
        qcStatus: "qc_passed",
        matchedRuleId: null,
        decisionBasis: qcResult.decisionBasis,
        description: description ?? null,
      })
      .returning({ id: scanRecords.id });

    return apiOk({
      scanId: scan?.id,
      scanNo,
      qcResult: "passed",
      qcStatus: "qc_passed",
      ticketId: null,
      v2RequestId,
      v2SkuRequestId,
      reason: qcResult.reason,
    });
  }

  // 6. 品控异常
  const OPEN_QC_STATUSES = ["level1_reviewing", "level2_reviewing", "rejected", "executing"];

  // 扫描幂等：查同 batchNo + skuCode 是否有未关闭品控工单
  const existingScans = await db
    .select({ ticketId: scanRecords.ticketId })
    .from(scanRecords)
    .where(
      and(
        eq(scanRecords.batchNo, batchNo!.trim()),
        eq(scanRecords.skuCode, skuCode!.trim()),
        inArray(scanRecords.qcStatus, ["qc_hold", "escalated"])
      )
    )
    .limit(1);

  let existingTicketId: string | null = null;
  if (existingScans.length > 0 && existingScans[0].ticketId) {
    // 检查关联工单是否未关闭
    const [ticket] = await db
      .select({ id: exceptionTickets.id, status: exceptionTickets.status })
      .from(exceptionTickets)
      .where(eq(exceptionTickets.id, existingScans[0].ticketId!))
      .limit(1);
    if (ticket && OPEN_QC_STATUSES.includes(ticket.status)) {
      existingTicketId = ticket.id;
    }
  }

  if (existingTicketId) {
    // 幂等：只追加扫描记录
    const [scan] = await db
      .insert(scanRecords)
      .values({
        scanNo,
        waybillSnapshotId: finalSnapId,
        v2ShipmentId: v2Detail.id,
        skuCode: skuCode!.trim(),
        skuName: v2Sku.skuName ?? null,
        skuSpec: v2Sku.skuSpec ?? null,
        expectedQuantity: String(expectedQty),
        actualQuantity: String(actualQty),
        batchNo: batchNo!.trim(),
        operatorId: me.id,
        deviceId: deviceId ?? null,
        qcResult: "abnormal",
        qcStatus: "qc_hold",
        matchedRuleId: qcResult.matchedRuleId,
        decisionBasis: qcResult.decisionBasis,
        ticketId: existingTicketId,
        description: description ?? null,
        holdDueAt: calcHoldDueAt(),
      })
      .returning({ id: scanRecords.id });

    return apiOk({
      scanId: scan?.id,
      scanNo,
      qcResult: "abnormal",
      qcStatus: "qc_hold",
      ticketId: existingTicketId,
      idempotent: true,
      message: "该批次已存在未关闭品控工单，仅追加扫描记录",
      v2RequestId,
      v2SkuRequestId,
      reason: qcResult.reason,
    });
  }

  // 无已有工单：事务内锁定库存 + 创建工单 + 写扫描记录 + 审计日志
  const ticketId = crypto.randomUUID();
  const ticketNo = generateTicketNo(now);
  const holdDueAt = calcHoldDueAt();

  // 路由审批层级（品控默认二级）
  const route = await routeApproval({
    category: "quality_control",
    subtype: qcResult.subtype ?? "quantity_mismatch",
    severity: qcResult.severity as Severity,
    estimatedAmount: 0,
  });

  try {
    await db.transaction(async (tx) => {
      // 1. 先创建品控异常工单（inventory_movements 的 ticket_id 外键依赖）
      await tx.insert(exceptionTickets).values({
        id: ticketId,
        ticketNo,
        waybillSnapshotId: finalSnapId,
        v2ShipmentId: v2Detail.id,
        source: "scan_qc",
        category: "quality_control",
        subtype: qcResult.subtype ?? "quantity_mismatch",
        severity: qcResult.severity as Severity,
        estimatedAmount: "0",
        description: description?.trim() || qcResult.reason,
        status: initialStatusForLevel(route.targetLevel),
        currentLevel: route.targetLevel,
        reporterId: me.id,
        resubmitCount: 0,
        version: 1,
        dueAt: route.dueAt,
        lastActionAt: now,
      });

      // 2. 锁定库存：找到或创建 inventory_items，增加 locked_quantity
      const [invRow] = await tx
        .select()
        .from(inventoryItems)
        .where(and(eq(inventoryItems.skuCode, skuCode!.trim()), eq(inventoryItems.batchNo, batchNo!.trim())))
        .limit(1);

      let invId: string;
      if (invRow) {
        const beforeAvail = Number(invRow.availableQuantity);
        const beforeLocked = Number(invRow.lockedQuantity);
        const afterLocked = beforeLocked + actualQty;
        await tx.update(inventoryItems).set({ lockedQuantity: String(afterLocked), status: "locked", updatedAt: now }).where(eq(inventoryItems.id, invRow.id));
        invId = invRow.id;

        // 写 lock 流水
        await tx.insert(inventoryMovements).values({
          ticketId,
          skuCode: skuCode!.trim(),
          batchNo: batchNo!.trim(),
          movementType: "lock" as MovementType,
          quantity: String(actualQty),
          beforeSnapshot: { available: beforeAvail, locked: beforeLocked },
          afterSnapshot: { available: beforeAvail, locked: afterLocked },
        });
      } else {
        const [newInv] = await tx
          .insert(inventoryItems)
          .values({
            skuCode: skuCode!.trim(),
            skuName: v2Sku.skuName ?? null,
            batchNo: batchNo!.trim(),
            availableQuantity: "0",
            lockedQuantity: String(actualQty),
            status: "locked",
          })
          .returning({ id: inventoryItems.id });
        invId = newInv?.id ?? crypto.randomUUID();

        await tx.insert(inventoryMovements).values({
          ticketId,
          skuCode: skuCode!.trim(),
          batchNo: batchNo!.trim(),
          movementType: "lock" as MovementType,
          quantity: String(actualQty),
          beforeSnapshot: { available: 0, locked: 0 },
          afterSnapshot: { available: 0, locked: actualQty },
        });
      }

      // 3. 写扫描记录
      await tx.insert(scanRecords).values({
        scanNo,
        waybillSnapshotId: finalSnapId,
        v2ShipmentId: v2Detail.id,
        skuCode: skuCode!.trim(),
        skuName: v2Sku.skuName ?? null,
        skuSpec: v2Sku.skuSpec ?? null,
        expectedQuantity: String(expectedQty),
        actualQuantity: String(actualQty),
        batchNo: batchNo!.trim(),
        operatorId: me.id,
        deviceId: deviceId ?? null,
        qcResult: "abnormal",
        qcStatus: "qc_hold",
        matchedRuleId: qcResult.matchedRuleId,
        decisionBasis: qcResult.decisionBasis,
        ticketId,
        description: description ?? null,
        holdDueAt,
      });

      // 审计日志
      await tx.insert(auditLogs).values({
        actorId: me.id,
        targetType: "ticket",
        targetId: ticketId,
        action: "scan_qc_create",
        detail: {
          ticketNo,
          scanNo,
          skuCode: skuCode!.trim(),
          batchNo: batchNo!.trim(),
          matchedRule: qcResult.ruleName,
          severity: qcResult.severity,
          reason: qcResult.reason,
          inventoryId: invId,
        },
      });
    });
  } catch (e) {
    console.error("[scan] 事务失败:", e);
    return apiError({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e), status: 500 });
  }

  // 可选：回写 V2 异常标记（非阻塞）
  try {
    const { v2ExceptionMarker } = await import("@/lib/v2-client");
    await v2ExceptionMarker(v2Detail.id, { hasOpenException: true, ticketNo, category: "quality_control" });
  } catch {
    // 非阻塞
  }

  return apiOk({
    ticketId,
    ticketNo,
    scanNo,
    qcResult: "abnormal",
    qcStatus: "qc_hold",
    severity: qcResult.severity,
    matchedRule: qcResult.ruleName,
    subtype: qcResult.subtype,
    reason: qcResult.reason,
    decisionBasis: qcResult.decisionBasis,
    targetLevel: route.targetLevel,
    dueAt: route.dueAt,
    holdDueAt,
    v2RequestId,
    v2SkuRequestId,
  });
}
