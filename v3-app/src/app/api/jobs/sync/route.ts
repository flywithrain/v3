import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  waybillSnapshots,
  waybillSkuSnapshots,
  integrationLogs,
} from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { apiOk, apiError } from "@/lib/auth";
import { v2Sync, V2ClientError } from "@/lib/v2-client";

/**
 * POST /api/jobs/sync — V2 运单增量同步定时任务（§6.6）
 *
 * 每 15 分钟调用 v2Sync() 同步最近 7 天有变更的运单快照。
 * 按 pageSize=50 分页遍历，对每条运单 upsert waybill_snapshots。
 * 与 timeout 任务共用相同的 CRON_SECRET 鉴权模式。
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    const { getCurrentUser } = await import("@/lib/auth");
    const me = await getCurrentUser(req);
    if (!me || !me.roleCodes.includes("admin" as never)) {
      return apiError({ code: "UNAUTHORIZED", message: "无权触发同步任务", status: 401 });
    }
  }

  // 最近 7 天的 ISO 时间戳
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  let totalSynced = 0;
  let page = 1;
  const pageSize = 50;
  const errors: string[] = [];
  const requestId = `sync_${Date.now()}`;
  const startedAt = Date.now();

  try {
    while (true) {
      let pageResult: Awaited<ReturnType<typeof v2Sync>>["data"];
      try {
        const r = await v2Sync(page, pageSize, since);
        pageResult = r.data;
      } catch (e) {
        if (e instanceof V2ClientError) {
          errors.push(`page=${page}: ${e.code} ${e.message}`);
          break; // V2 不可用则停止
        }
        throw e;
      }

      if (!pageResult || !pageResult.items || pageResult.items.length === 0) break;

      const now = new Date();
      for (const item of pageResult.items) {
        try {
          await db
            .insert(waybillSnapshots)
            .values({
              v2ShipmentId: item.id,
              externalCode: item.externalCode ?? null,
              storeName: item.storeName ?? null,
              skuCount: item.skuCount ?? 0,
              totalQuantity: item.totalQuantity ?? "0",
              batchId: item.batchId ?? null,
              amount: "0",
              rawPayload: item,
              sourceSyncedAt: new Date(item.submittedAt || now),
              sourceVersion: "v1",
            })
            .onConflictDoUpdate({
              target: waybillSnapshots.v2ShipmentId,
              set: {
                externalCode: item.externalCode ?? null,
                storeName: item.storeName ?? null,
                skuCount: item.skuCount ?? 0,
                totalQuantity: item.totalQuantity ?? "0",
                batchId: item.batchId ?? null,
                rawPayload: item,
                sourceSyncedAt: new Date(item.submittedAt || now),
                updatedAt: now,
              },
            });
          totalSynced++;
        } catch (e) {
          errors.push(`upsert ${item.id}: ${(e as Error).message}`);
        }
      }

      // 写入同步日志
      await db.insert(integrationLogs).values({
        requestId: `${requestId}_p${page}`,
        direction: "v3_to_v2",
        endpoint: "/api/v1/shipments",
        method: "GET",
        requestSummary: { page, pageSize, since, synced: pageResult.items.length },
        statusCode: 200,
        success: true,
        durationMs: 0,
      });

      if (pageResult.items.length < pageSize) break; // 最后一页
      page++;
    }

    const durMs = Date.now() - startedAt;
    return apiOk({
      totalSynced,
      pagesFetched: page,
      durationMs: durMs,
      requestId,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e) {
    return apiError({ code: "INTERNAL", message: `同步失败: ${(e as Error).message}`, status: 500 });
  }
}
