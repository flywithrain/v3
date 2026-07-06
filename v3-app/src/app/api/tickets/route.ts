import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  exceptionTickets,
  waybillSnapshots,
  waybillSkuSnapshots,
  integrationLogs,
  users,
} from "@/lib/db-schema";
import { eq, and, inArray, desc, sql as drizzleSql, ilike, or } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { routeApproval, initialStatusForLevel } from "@/lib/approval-engine";
import { v2Lookup, V2ClientError } from "@/lib/v2-client";
import { generateTicketNo } from "@/lib/utils";
import type { ApiException } from "@/types";

// 未关闭态：用于“同一运单同 subtype 未关闭工单”重复上报检查
const OPEN_STATUSES = [
  "draft",
  "pending_review",
  "level1_reviewing",
  "level2_reviewing",
  "rejected",
  "executing",
];

/** GET /api/tickets — 工单分页列表（§11.4 子集） */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const p = req.nextUrl.searchParams;
  const page = Math.max(1, Number(p.get("page") ?? "1") || 1);
  const pageSize = Math.min(100, Math.max(1, Number(p.get("pageSize") ?? "20") || 20));
  const status = p.get("status")?.trim();
  const category = p.get("category")?.trim();
  const source = p.get("source")?.trim();
  const subtype = p.get("subtype")?.trim();
  const search = p.get("search")?.trim(); // 工单号或外部编码

  const conds = [];
  if (status) conds.push(eq(exceptionTickets.status, status));
  if (category) conds.push(eq(exceptionTickets.category, category));
  if (source) conds.push(eq(exceptionTickets.source, source));
  if (subtype) conds.push(eq(exceptionTickets.subtype, subtype));
  if (search) {
    conds.push(
      or(
        ilike(exceptionTickets.ticketNo, `%${search}%`),
        ilike(exceptionTickets.v2ShipmentId, `%${search}%`)
      )!
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [countRow] = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(exceptionTickets)
    .where(where)
    .execute();
  const total = Number(countRow?.count ?? 0);

  const rows = await db
    .select()
    .from(exceptionTickets)
    .where(where)
    .orderBy(desc(exceptionTickets.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // 取 externalCode：批量查 waybill_snapshots
  const snapshotIds = rows.map((r) => r.waybillSnapshotId).filter(Boolean) as string[];
  const codeMap = new Map<string, string | null>();
  if (snapshotIds.length > 0) {
    const snaps = await db
      .select({ id: waybillSnapshots.id, externalCode: waybillSnapshots.externalCode })
      .from(waybillSnapshots)
      .where(inArray(waybillSnapshots.id, snapshotIds));
    snaps.forEach((s) => codeMap.set(s.id, s.externalCode));
  }

  // 取审批人名称 + 启用状态
  const approverIds = rows.map((r) => r.assignedApproverId).filter(Boolean) as string[];
  const approverMap = new Map<string, { name: string; enabled: boolean }>();
  if (approverIds.length > 0) {
    const approvers = await db.select({ id: users.id, name: users.name, enabled: users.enabled }).from(users).where(inArray(users.id, approverIds));
    approvers.forEach((a) => approverMap.set(a.id, { name: a.name, enabled: a.enabled ?? false }));
  }

  return apiOk({
    page,
    pageSize,
    total,
    items: rows.map((r) => ({
      id: r.id,
      ticketNo: r.ticketNo,
      source: r.source,
      category: r.category,
      subtype: r.subtype,
      severity: r.severity,
      estimatedAmount: r.estimatedAmount,
      status: r.status,
      currentLevel: r.currentLevel,
      externalCode: r.waybillSnapshotId ? codeMap.get(r.waybillSnapshotId) ?? null : null,
      v2ShipmentId: r.v2ShipmentId,
      assignedApproverName: r.assignedApproverId ? approverMap.get(r.assignedApproverId)?.name ?? null : null,
      assignedApproverEnabled: r.assignedApproverId ? approverMap.get(r.assignedApproverId)?.enabled ?? null : null,
      dueAt: r.dueAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      version: r.version,
    })),
  });
}

/** POST /api/tickets — 创建人工物流异常工单（§10.2） */
export async function POST(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  // operator 以下角色不得创建（auditor 等只读角色禁）
  const allowed = ["operator", "warehouse_operator", "admin"];
  if (!allowed.some((r) => me.roleCodes.includes(r))) {
    return apiError({ code: "FORBIDDEN", message: "当前角色无权创建工单", status: 403 });
  }

  let body: {
    shipmentId?: string;
    externalCode?: string;
    subtype?: string;
    severity?: string;
    estimatedAmount?: number;
    description?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { shipmentId, externalCode, subtype, severity, estimatedAmount, description } = body;
  if ((!shipmentId?.trim() && !externalCode?.trim()) || !subtype?.trim() || !description?.trim()) {
    return apiError({ code: "BAD_REQUEST", message: "需提供 shipmentId/externalCode、subtype、description", status: 400 });
  }
  if (!["low", "medium", "high"].includes(severity ?? "")) {
    return apiError({ code: "BAD_REQUEST", message: "severity 需为 low/medium/high", status: 400 });
  }

  // 1. 实时调 V2 校验并获取详情
  let v2Detail: Awaited<ReturnType<typeof v2Lookup>>["data"];
  let v2RequestId = "N/A";
  try {
    const r = await v2Lookup({ shipmentId: shipmentId?.trim(), externalCode: externalCode?.trim() });
    v2RequestId = r.requestId;
    v2Detail = r.data;
  } catch (e) {
    if (e instanceof V2ClientError && e.code === "V2_UNAVAILABLE") {
      // V2 不可用降级：禁止创建新异常（§6.6）
      return apiError({ code: "V2_UNAVAILABLE", message: "V2 不可用，无法实时校验，禁止创建异常", status: 503 });
    }
    throw e;
  }

  if (!v2Detail) {
    // §16.1 期望：工单不创建，已有失败日志（v2 写日志失败时这里补记录）
    return apiError({
      code: "WAYBILL_NOT_FOUND",
      message: `V2 未找到该运单（requestId=${v2RequestId}），不创建工单`,
      status: 404,
    } as ApiException);
  }

  // 2. 刷新/写入 waybill_snapshots + sku snapshots
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
      amount: "0", // V2 无金额，默认 0（§8.2 假设）
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
        receiverName: v2Detail.receiverName ?? null,
        receiverPhoneMasked: v2Detail.receiverPhone ?? null,
        receiverAddressSummary: v2Detail.receiverAddress ?? null,
        skuCount: v2Detail.skuCount ?? (v2Detail.items?.length ?? 0),
        totalQuantity: v2Detail.totalQuantity ?? "0",
        batchId: v2Detail.batchId ?? null,
        rawPayload: v2Detail,
        sourceSyncedAt: now,
        updatedAt: now,
      },
    });

  // 取已存在/新建的 snapshot id（onConflict 时 v2ShipmentId 唯一）
  const [snapRow] = await db
    .select({ id: waybillSnapshots.id })
    .from(waybillSnapshots)
    .where(eq(waybillSnapshots.v2ShipmentId, v2Detail.id))
    .limit(1);
  const finalSnapId = snapRow?.id ?? snapId;

  // 刷新 SKU 快照：先删后插（按 waybillSnapshotId）
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

  // 3. 同一运单同 subtype 未关闭工单检查
  const openExisting = await db
    .select({ id: exceptionTickets.id, ticketNo: exceptionTickets.ticketNo })
    .from(exceptionTickets)
    .where(
      and(
        eq(exceptionTickets.v2ShipmentId, v2Detail.id),
        eq(exceptionTickets.subtype, subtype!.trim()),
        inArray(exceptionTickets.status, OPEN_STATUSES)
      )
    )
    .limit(1);
  if (openExisting.length > 0) {
    return apiError({
      code: "DUPLICATE_OPEN_TICKET",
      message: `该运单已存在未关闭的同类型工单 ${openExisting[0].ticketNo}，请勿重复上报`,
      status: 409,
    } as ApiException);
  }

  // 4. 路由审批层级
  const amount = Number(estimatedAmount ?? 0);
  const route = await routeApproval({
    category: "logistics",
    subtype: subtype!.trim(),
    severity: severity as "low" | "medium" | "high",
    estimatedAmount: amount,
  });

  const ticketId = crypto.randomUUID();
  const ticketNo = generateTicketNo(now);
  await db.insert(exceptionTickets).values({
    id: ticketId,
    ticketNo,
    waybillSnapshotId: finalSnapId,
    v2ShipmentId: v2Detail.id,
    source: "manual_report",
    category: "logistics",
    subtype: subtype!.trim(),
    severity: severity!,
    estimatedAmount: String(amount),
    description: description!.trim(),
    status: initialStatusForLevel(route.targetLevel),
    currentLevel: route.targetLevel,
    reporterId: me.id,
    resubmitCount: 0,
    version: 1,
    dueAt: route.dueAt,
    lastActionAt: now,
  });

  // 写一条指令日志触发动作（便于审计），便于前端在详情中提示路由原因
  await db.insert(integrationLogs).values({
    requestId: `local_${crypto.randomUUID()}`,
    direction: "v3_to_v2",
    endpoint: "(local)-ticket_create",
    method: "POST",
    requestSummary: { ticketId, ticketNo, v2RequestId, routeReason: route.reason, targetLevel: route.targetLevel },
    statusCode: 201,
    success: true,
    durationMs: 0,
  });

  return apiOk({
    id: ticketId,
    ticketNo,
    v2ShipmentId: v2Detail.id,
    externalCode: v2Detail.externalCode,
    status: initialStatusForLevel(route.targetLevel),
    currentLevel: route.targetLevel,
    dueAt: route.dueAt,
    routeReason: route.reason,
    matchedRuleId: route.matchedRuleId,
    v2RequestId,
    version: 1,
  });
}
