import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { integrationLogs } from "@/lib/db-schema";
import { eq, desc, inArray, and } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";

/** GET /api/integrations/logs — 最近接口调用日志（§11.8 子集） */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const p = req.nextUrl.searchParams;
  const page = Math.max(1, Number(p.get("page") ?? "1") || 1);
  const pageSize = Math.min(200, Math.max(1, Number(p.get("pageSize") ?? "50") || 50));
  const requestId = p.get("requestId")?.trim();
  const success = p.get("success")?.trim();
  const errorCategory = p.get("errorCategory")?.trim();

  const conds = [];
  if (requestId) conds.push(eq(integrationLogs.requestId, requestId));
  if (success === "true") conds.push(eq(integrationLogs.success, true));
  if (success === "false") conds.push(eq(integrationLogs.success, false));
  if (errorCategory) {
    const codeMap: Record<string, string[]> = {
      "404": ["WAYBILL_NOT_FOUND", "HTTP_404"],
      "401": ["V2_UNAUTHORIZED", "UNAUTHORIZED", "HTTP_401"],
      timeout: ["V2_TIMEOUT"],
      "5xx": ["V2_INTERNAL", "HTTP_500", "HTTP_502", "HTTP_503"],
      network: ["V2_NETWORK_ERROR", "V2_UNAVAILABLE", "V2_BASE_NOT_SET"],
    };
    const codes = codeMap[errorCategory] ?? [errorCategory];
    conds.push(inArray(integrationLogs.errorCode, codes));
  }
  const where = conds.length ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;

  const rows = await db
    .select()
    .from(integrationLogs)
    .where(where ?? undefined)
    .orderBy(desc(integrationLogs.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // 统计最近成功率和最近同步时间
  const recent = await db.select().from(integrationLogs).orderBy(desc(integrationLogs.createdAt)).limit(100);
  const successCount = recent.filter((r) => r.success).length;
  const successRate = recent.length > 0 ? successCount / recent.length : null;
  const lastSync = recent[0]?.createdAt ?? null;

  return apiOk({
    page,
    pageSize,
    items: rows,
    summary: {
      recentCount: recent.length,
      successRate,
      lastSyncAt: lastSync,
    },
  });
}
