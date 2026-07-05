import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { exceptionTickets, waybillSnapshots, waybillSkuSnapshots } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { v2Lookup, V2ClientError } from "@/lib/v2-client";

/**
 * POST /api/tickets/[id]/refresh-v2 — 刷新该工单关联运单的 V2 最新数据（§11.5 操作）。
 * 重新调 V2 lookup 并更新本地快照 + SKU 明细。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const { id } = await params;
  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
  if (!ticket) return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });
  if (!ticket.waybillSnapshotId) return apiError({ code: "BAD_REQUEST", message: "工单未关联运单快照", status: 400 });

  const [snap] = await db.select().from(waybillSnapshots).where(eq(waybillSnapshots.id, ticket.waybillSnapshotId)).limit(1);
  if (!snap) return apiError({ code: "NOT_FOUND", message: "运单快照不存在", status: 404 });

  let r;
  try {
    r = await v2Lookup({ shipmentId: snap.v2ShipmentId });
  } catch (e) {
    if (e instanceof V2ClientError && e.code === "V2_UNAVAILABLE") {
      return apiError({ code: "V2_UNAVAILABLE", message: "V2 不可用，仍展示本地缓存", status: 503 });
    }
    throw e;
  }

  if (!r.data) {
    return apiError({ code: "WAYBILL_NOT_FOUND", message: `V2 未找到该运单（requestId=${r.requestId}）`, status: 404 });
  }

  const now = new Date();
  await db
    .update(waybillSnapshots)
    .set({
      externalCode: r.data.externalCode ?? null,
      storeName: r.data.storeName ?? null,
      receiverName: r.data.receiverName ?? null,
      receiverPhoneMasked: r.data.receiverPhone ?? null,
      receiverAddressSummary: r.data.receiverAddress ?? null,
      skuCount: r.data.skuCount ?? (r.data.items?.length ?? 0),
      totalQuantity: r.data.totalQuantity ?? "0",
      batchId: r.data.batchId ?? null,
      rawPayload: r.data,
      sourceSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(waybillSnapshots.id, snap.id));

  // 刷新 SKU 快照
  await db.delete(waybillSkuSnapshots).where(eq(waybillSkuSnapshots.waybillSnapshotId, snap.id));
  if (r.data.items && r.data.items.length > 0) {
    await db.insert(waybillSkuSnapshots).values(
      r.data.items.map((it) => ({
        waybillSnapshotId: snap.id,
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

  return apiOk({ refreshedAt: now, v2RequestId: r.requestId, snapshotId: snap.id });
}
