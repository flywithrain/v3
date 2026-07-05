import { NextRequest } from "next/server";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { v2Lookup, V2ClientError } from "@/lib/v2-client";

/**
 * GET /api/waybills/lookup — 前端"上报异常"页实时查询 V2 运单（脱敏）。
 * 入参：?shipmentId= | ?externalCode=
 * 透传 V2 的脱敏后详情 + SKU 明细。
 */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const p = req.nextUrl.searchParams;
  const shipmentId = p.get("shipmentId")?.trim() || undefined;
  const externalCode = p.get("externalCode")?.trim() || undefined;
  if (!shipmentId && !externalCode) {
    return apiError({ code: "BAD_REQUEST", message: "需提供 shipmentId 或 externalCode", status: 400 });
  }

  try {
    const r = await v2Lookup({ shipmentId, externalCode });
    if (!r.data) {
      return apiOk({ found: false, requestId: r.requestId, data: null });
    }
    return apiOk({ found: true, requestId: r.requestId, data: r.data });
  } catch (e) {
    if (e instanceof V2ClientError && e.code === "V2_UNAVAILABLE") {
      return apiError({ code: "V2_UNAVAILABLE", message: "V2 不可用，请稍后重试", status: 503 });
    }
    throw e;
  }
}
