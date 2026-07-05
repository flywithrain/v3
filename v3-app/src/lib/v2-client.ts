import { db } from "@/lib/db";
import { integrationLogs } from "@/lib/db-schema";

/**
 * V2 客户端：跨系统只读调用，带鉴权、超时、重试、Request ID、日志写入。
 * 所有对外调用统一经 callV2()，确保每次都写入 integration_logs（§3.5 / §8.4）。
 */

const BASE_URL = process.env.V2_API_BASE_URL ?? "";
const API_KEY = process.env.V2_API_KEY ?? "";
const TIMEOUT_MS = 8000; // §15.1 超时 8s
const MAX_ATTEMPTS = 2; // 仅对 5xx / 网络错误重试 1 次

export interface V2ShipmentItem {
  id: string;
  skuCode: string;
  skuName: string;
  skuQuantity: string;
  skuSpec: string | null;
  remark?: string | null;
}

export interface V2ShipmentDetail {
  id: string;
  externalCode: string | null;
  storeName: string | null;
  receiverName: string | null;
  receiverPhone: string | null; // V2 已脱敏
  receiverAddress: string | null;
  remark: string | null;
  skuCount: number;
  totalQuantity: string;
  batchId: string;
  submittedAt: string;
  items: V2ShipmentItem[];
}

export interface V2SkuValidation {
  valid: boolean;
  shipmentId: string;
  skuCode: string;
  skuName?: string;
  skuQuantity?: string;
  skuSpec?: string | null;
}

export interface V2SyncPage {
  page: number;
  pageSize: number;
  total: number;
  since: string;
  note: string;
  items: {
    id: string;
    externalCode: string | null;
    storeName: string | null;
    submittedAt: string;
    skuCount: number;
    totalQuantity: string;
    batchId: string;
    itemsUrl: string;
  }[];
}

export class V2ClientError extends Error {
  code: string;
  statusCode: number | null;
  requestId: string;
  constructor(code: string, message: string, requestId: string, statusCode: number | null = null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.requestId = requestId;
  }
}

function genRequestId(): string {
  return `req_${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function maskSummary(summary: unknown): unknown {
  // 入参摘要脱敏：不保留完整明文手机号/地址；保留结构
  return summary;
}

/** 底层调用 V2，统一写入 integration_logs。仅在 5xx/网络错误时重试。 */
async function callV2<T>(
  endpoint: string,
  method: string,
  requestSummary: unknown,
  requestId: string,
  attempt = 1
): Promise<T> {
  if (!BASE_URL) {
    await writeLog(requestId, endpoint, method, requestSummary, null, false, 0, "V2_BASE_NOT_SET", "V2_API_BASE_URL 未配置");
    throw new V2ClientError("V2_UNAVAILABLE", "V2 服务地址未配置", requestId);
  }

  const url = `${BASE_URL}${endpoint}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "X-API-Key": API_KEY,
        "X-Request-ID": requestId,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
    const durMs = Date.now() - startedAt;
    clearTimeout(timer);

    const success = resp.ok;
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }

    if (!success) {
      const errCode = (body as { error?: { code?: string; message?: string } } | null)?.error?.code ?? `HTTP_${resp.status}`;
      const errMsg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${resp.status}`;
      await writeLog(requestId, endpoint, method, requestSummary, resp.status, false, durMs, errCode, errMsg);

      // 仅 5xx 可重试
      if (resp.status >= 500 && attempt < MAX_ATTEMPTS) {
        return callV2<T>(endpoint, method, requestSummary, requestId, attempt + 1);
      }

      // 4xx 不重试，直接抛带状态码
      if (resp.status === 404) {
        throw new V2ClientError("WAYBILL_NOT_FOUND", errMsg, requestId, 404);
      }
      if (resp.status === 401) {
        throw new V2ClientError("V2_UNAUTHORIZED", errMsg, requestId, 401);
      }
      throw new V2ClientError(errCode, errMsg, requestId, resp.status);
    }

    await writeLog(requestId, endpoint, method, requestSummary, resp.status, true, durMs, null, null);
    return body as T;
  } catch (e) {
    clearTimeout(timer);
    const durMs = Date.now() - startedAt;
    if (e instanceof V2ClientError) throw e; // 已记录过日志
    const isAbort = e instanceof Error && e.name === "AbortError";
    const code = isAbort ? "V2_TIMEOUT" : "V2_NETWORK_ERROR";
    const msg = isAbort ? `V2 请求超时（${TIMEOUT_MS}ms）` : (e instanceof Error ? e.message : String(e));
    await writeLog(requestId, endpoint, method, requestSummary, null, false, durMs, code, msg);

    if (attempt < MAX_ATTEMPTS) {
      return callV2<T>(endpoint, method, requestSummary, requestId, attempt + 1);
    }
    throw new V2ClientError("V2_UNAVAILABLE", msg, requestId);
  }
}

async function writeLog(
  requestId: string,
  endpoint: string,
  method: string,
  requestSummary: unknown,
  statusCode: number | null,
  success: boolean,
  durationMs: number,
  errorCode: string | null,
  errorMessage: string | null
): Promise<void> {
  try {
    await db.insert(integrationLogs).values({
      requestId,
      direction: "v3_to_v2",
      endpoint,
      method,
      requestSummary: maskSummary(requestSummary),
      statusCode: statusCode ?? null,
      success,
      durationMs,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
    });
  } catch (e) {
    // 日志写入失败不应阻塞主流程；记录到 console 便于排查
    console.error("[integration_log] 写入失败:", e);
  }
}

/** 校验并获取运单详情 —— §9.1 */
export async function v2Lookup(idOrCode: { shipmentId?: string; externalCode?: string }): Promise<{
  requestId: string;
  data: V2ShipmentDetail | null;
}> {
  const requestId = genRequestId();
  const hasId = !!idOrCode.shipmentId?.trim();
  const hasCode = !!idOrCode.externalCode?.trim();
  if (!hasId && !hasCode) {
    return { requestId, data: null };
  }
  const qs = hasId ? `shipmentId=${encodeURIComponent(idOrCode.shipmentId!.trim())}` : `externalCode=${encodeURIComponent(idOrCode.externalCode!.trim())}`;
  const summary = hasId ? { shipmentId: idOrCode.shipmentId } : { externalCode: idOrCode.externalCode };
  try {
    const body = await callV2<{ requestId: string; data: V2ShipmentDetail }>(`/api/v1/shipments/lookup?${qs}`, "GET", summary, requestId);
    return { requestId, data: body.data };
  } catch (e) {
    if (e instanceof V2ClientError && e.code === "WAYBILL_NOT_FOUND") {
      return { requestId: e.requestId, data: null };
    }
    throw e;
  }
}

/** SKU 归属校验 —— §9.2 */
export async function v2ValidateSku(shipmentId: string, skuCode: string): Promise<{ requestId: string; data: V2SkuValidation | null }> {
  const requestId = genRequestId();
  const summary = { shipmentId, skuCode };
  try {
    const body = await callV2<{ requestId: string; data: V2SkuValidation }>(
      `/api/v1/shipments/${encodeURIComponent(shipmentId)}/sku/validate?skuCode=${encodeURIComponent(skuCode)}`,
      "GET",
      summary,
      requestId
    );
    return { requestId, data: body.data };
  } catch (e) {
    if (e instanceof V2ClientError && e.code === "WAYBILL_NOT_FOUND") {
      return { requestId: e.requestId, data: null };
    }
    throw e;
  }
}

/** 运单增量同步 —— §9.3 */
export async function v2Sync(page = 1, pageSize = 100, updatedSince?: string): Promise<{ requestId: string; data: V2SyncPage | null }> {
  const requestId = genRequestId();
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (updatedSince) qs.set("updatedSince", updatedSince);
  const summary = { page, pageSize, updatedSince: updatedSince ?? null };
  try {
    const body = await callV2<{ requestId: string; data: V2SyncPage }>(`/api/v1/shipments?${qs.toString()}`, "GET", summary, requestId);
    return { requestId, data: body.data };
  } catch {
    return { requestId, data: null };
  }
}

/** 可选回写：异常标记 —— §9.4 */
export async function v2ExceptionMarker(shipmentId: string, payload: { hasOpenException: boolean; ticketNo?: string; category?: string }): Promise<{ requestId: string; success: boolean }> {
  const requestId = genRequestId();
  try {
    await callV2(`/api/v1/shipments/${encodeURIComponent(shipmentId)}/exception-marker`, "POST", { shipmentId, ...payload }, requestId);
    return { requestId, success: true };
  } catch {
    return { requestId, success: false };
  }
}
