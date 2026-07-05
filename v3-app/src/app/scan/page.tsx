"use client";

import { useState } from "react";
import { ScanLine, CheckCircle, AlertTriangle, Loader2 } from "lucide-react";
import { apiFetch, useSession, ApiError } from "@/components/shared/auth-context";
import { useToast } from "@/components/shared/toast";

interface ScanResult {
  scanId?: string;
  scanNo?: string;
  ticketId?: string | null;
  ticketNo?: string;
  qcResult: "passed" | "abnormal";
  qcStatus: string;
  severity?: string;
  matchedRule?: string | null;
  subtype?: string | null;
  reason: string;
  decisionBasis?: unknown;
  targetLevel?: number;
  dueAt?: string;
  holdDueAt?: string;
  idempotent?: boolean;
  message?: string;
  v2RequestId?: string;
}

export default function ScanPage() {
  const { user } = useSession();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  const [form, setForm] = useState({
    shipmentId: "",
    skuCode: "",
    actualQuantity: "",
    skuSpec: "",
    batchNo: "",
    deviceId: "",
    description: "",
  });

  const canScan = user?.roleCodes.some((r) =>
    ["warehouse_operator", "qc_supervisor", "admin"].includes(r)
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.shipmentId.trim() || !form.skuCode.trim() || !form.batchNo.trim()) {
      toast.showToast("请填写运单ID、SKU编码和批次号", "error");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const r = await apiFetch<ScanResult>("/api/scan", {
        method: "POST",
        body: JSON.stringify({
          shipmentId: form.shipmentId.trim(),
          skuCode: form.skuCode.trim(),
          actualQuantity: Number(form.actualQuantity) || 0,
          skuSpec: form.skuSpec.trim() || undefined,
          batchNo: form.batchNo.trim(),
          deviceId: form.deviceId.trim() || undefined,
          description: form.description.trim() || undefined,
        }),
      });
      setResult(r);
      if (r.qcResult === "passed") {
        toast.showToast("品控通过，可正常出库", "success");
      } else {
        toast.showToast(r.message ?? `品控异常：${r.matchedRule ?? r.reason}`, "error");
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "扫描失败";
      toast.showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  }

  if (!canScan) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <header className="mb-4 flex items-center gap-2">
          <ScanLine className="h-6 w-6 text-[var(--color-primary)]" />
          <h1 className="text-xl font-bold text-[var(--color-text-main)]">扫描品控</h1>
        </header>
        <div className="alert alert-info">
          当前角色无权执行扫描操作。需要 仓储操作员 / 品控主管 / 管理员 角色。
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex items-center gap-2">
        <ScanLine className="h-6 w-6 text-[var(--color-primary)]" />
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">扫描品控</h1>
      </header>
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        扫描录入后实时调 V2 校验运单与 SKU 归属，自动执行品控规则引擎。异常时锁定批次并创建品控工单。
      </p>

      <form onSubmit={handleSubmit} className="card space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium">运单 ID / 外部编码 *</span>
            <input
              value={form.shipmentId}
              onChange={(e) => setForm({ ...form, shipmentId: e.target.value })}
              placeholder="输入 V2 运单 ID 或 externalCode"
              className="input-field mt-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">SKU 编码 *</span>
            <input
              value={form.skuCode}
              onChange={(e) => setForm({ ...form, skuCode: e.target.value })}
              placeholder="如 SKU-001"
              className="input-field mt-1"
            />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm font-medium">实扫数量</span>
            <input
              type="number"
              value={form.actualQuantity}
              onChange={(e) => setForm({ ...form, actualQuantity: e.target.value })}
              placeholder="如 10"
              className="input-field mt-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">实扫规格</span>
            <input
              value={form.skuSpec}
              onChange={(e) => setForm({ ...form, skuSpec: e.target.value })}
              placeholder="如 规格-A"
              className="input-field mt-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">批次号 *</span>
            <input
              value={form.batchNo}
              onChange={(e) => setForm({ ...form, batchNo: e.target.value })}
              placeholder="如 BATCH-001"
              className="input-field mt-1"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium">设备 ID</span>
            <input
              value={form.deviceId}
              onChange={(e) => setForm({ ...form, deviceId: e.target.value })}
              placeholder="如 PDA-01"
              className="input-field mt-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">异常描述</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="如 外包装破损二级"
              className="input-field mt-1"
            />
          </label>
        </div>
        <button type="submit" disabled={loading} className="btn-primary flex items-center gap-2">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "扫描校验中…" : "扫描校验"}
        </button>
      </form>

      {result && (
        <div className="card mt-4">
          <div className="flex items-center gap-2 mb-3">
            {result.qcResult === "passed" ? (
              <CheckCircle className="h-5 w-5 text-green-500" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-orange-500" />
            )}
            <h2 className="text-lg font-bold">
              品控{result.qcResult === "passed" ? "通过" : "异常"}
              {result.idempotent && (
                <span className="ml-2 text-sm font-normal text-[var(--color-text-muted)]">
                  （幂等：仅追加扫描记录）
                </span>
              )}
            </h2>
          </div>
          <div className="space-y-1 text-sm">
            <div><span className="text-[var(--color-text-muted)]">扫描号：</span>{result.scanNo}</div>
            <div><span className="text-[var(--color-text-muted)]">批次状态：</span><span className="tag tag-teal">{result.qcStatus}</span></div>
            <div><span className="text-[var(--color-text-muted)]">判定依据：</span>{result.reason}</div>
            {result.matchedRule && (
              <div><span className="text-[var(--color-text-muted)]">命中规则：</span>{result.matchedRule}</div>
            )}
            {result.subtype && (
              <div><span className="text-[var(--color-text-muted)]">异常子类型：</span>{result.subtype}</div>
            )}
            {result.severity && (
              <div><span className="text-[var(--color-text-muted)]">严重度：</span>
                <span className={`tag ${result.severity === "high" ? "tag-red" : result.severity === "medium" ? "tag-orange" : "tag-green"}`}>
                  {result.severity}
                </span>
              </div>
            )}
            {result.ticketId && (
              <div>
                <span className="text-[var(--color-text-muted)]">关联工单：</span>
                <a href={`/tickets/${result.ticketId}`} className="text-[var(--color-primary)] underline">
                  {result.ticketNo ?? result.ticketId}
                </a>
              </div>
            )}
            {result.holdDueAt && (
              <div><span className="text-[var(--color-text-muted)]">暂扣超时：</span>{new Date(result.holdDueAt).toLocaleString("zh-CN")}</div>
            )}
            {result.decisionBasis != null && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[var(--color-text-muted)]">判定详情</summary>
                <pre className="mt-1 rounded bg-[var(--color-bg-secondary)] p-2 text-xs overflow-x-auto">
                  {JSON.stringify(result.decisionBasis, null, 2)}
                </pre>
              </details>
            )}
          </div>
          {result.ticketId && result.qcResult === "abnormal" && (
            <div className="mt-3 border-t pt-3">
              <QuickReleaseSection ticketId={result.ticketId} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuickReleaseSection({ ticketId }: { ticketId: string }) {
  const { user } = useSession();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [showForm, setShowForm] = useState(false);

  const isQcSupervisor = user?.roleCodes.includes("qc_supervisor");
  if (!isQcSupervisor) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        仅品控主管可执行误判快速放行。
      </p>
    );
  }

  async function handleRelease() {
    if (!reason.trim()) {
      toast.showToast("请填写复核原因", "error");
      return;
    }
    setLoading(true);
    try {
      await apiFetch(`/api/tickets/${ticketId}/quick-release`, {
        method: "POST",
        idempotencyKey: `qr-${Date.now()}`,
        body: JSON.stringify({ reason: reason.trim(), expectedVersion: 1 }),
      });
      toast.showToast("快速放行成功，批次已解锁", "success");
      setShowForm(false);
      setReason("");
    } catch (e) {
      toast.showToast(e instanceof ApiError ? e.message : "放行失败", "error");
    } finally {
      setLoading(false);
    }
  }

  if (!showForm) {
    return (
      <button onClick={() => setShowForm(true)} className="btn-ghost text-sm">
        误判快速放行（品控主管）
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="text-sm font-medium">复核原因 *</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="如：复核为扫描误判，实物规格与运单一致"
          rows={2}
          className="input-field mt-1"
        />
      </label>
      <div className="flex gap-2">
        <button onClick={handleRelease} disabled={loading} className="btn-primary !py-1 !px-3 text-sm">
          {loading ? "放行中…" : "确认放行"}
        </button>
        <button onClick={() => setShowForm(false)} className="btn-ghost !py-1 !px-3 text-sm">取消</button>
      </div>
    </div>
  );
}
