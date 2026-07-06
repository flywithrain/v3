"use client";

import { useState } from "react";
import { ScanLine, CheckCircle, AlertTriangle, Loader2, Zap, Package, Hash, Ruler, AlertOctagon } from "lucide-react";
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

interface ScanForm {
  shipmentId: string;
  skuCode: string;
  actualQuantity: string;
  skuSpec: string;
  batchNo: string;
  deviceId: string;
  /** 预估赔付金额（元），默认 0 */
  estimatedAmount: string;
  /** 异常观察：损伤等级（0=无损伤, 1-5） */
  damageLevel: number;
  /** 异常观察：损伤部位 */
  damageLocation: string;
  /** 异常观察：自由描述 */
  description: string;
}

const DAMAGE_LEVELS = [
  { value: 0, label: "无损伤", desc: "（正常，外观完好）" },
  { value: 1, label: "1级 — 轻微瑕疵", desc: "划痕、褶皱、标签翘角，不影响使用" },
  { value: 2, label: "2级 — 外包装破损", desc: "纸箱压痕、胶带开裂，内件完好" },
  { value: 3, label: "3级 — 内包装破损", desc: "气泡膜破裂、内盒变形，产品可能受影响" },
  { value: 4, label: "4级 — 产品损伤", desc: "产品划痕、凹陷、漏液，影响销售" },
  { value: 5, label: "5级 — 完全报废", desc: "碎裂、严重漏液、无法使用" },
];

const DAMAGE_LOCATIONS = [
  { value: "", label: "不涉及" },
  { value: "外包装", label: "外包装" },
  { value: "内包装", label: "内包装" },
  { value: "产品本体", label: "产品本体" },
];

type PresetKey = "normal" | "quantity" | "damage" | "spec" | "batch";

const PRESETS: { key: PresetKey; label: string; icon: React.ReactNode; hint: string }[] = [
  { key: "normal", label: "正常", icon: <CheckCircle className="h-4 w-4" />, hint: "外观完好、数量正确" },
  { key: "damage", label: "外观破损", icon: <AlertOctagon className="h-4 w-4" />, hint: "外包装/内件/产品损伤" },
  { key: "quantity", label: "数量差异", icon: <Hash className="h-4 w-4" />, hint: "实扫数量≠运单数量" },
  { key: "spec", label: "规格不符", icon: <Ruler className="h-4 w-4" />, hint: "实际规格≠运单规格" },
  { key: "batch", label: "批次风险", icon: <Package className="h-4 w-4" />, hint: "召回/过期/禁售批次" },
];

export default function ScanPage() {
  const { user } = useSession();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [activePreset, setActivePreset] = useState<PresetKey | null>(null);

  const [form, setForm] = useState<ScanForm>({
    shipmentId: "",
    skuCode: "",
    actualQuantity: "",
    skuSpec: "",
    batchNo: "",
    deviceId: "",
    estimatedAmount: "",
    damageLevel: 0,
    damageLocation: "",
    description: "",
  });

  const canScan = user?.roleCodes.some((r) =>
    ["warehouse_operator", "qc_supervisor", "admin"].includes(r)
  );

  function applyPreset(key: PresetKey) {
    if (activePreset === key) {
      // 再次点击取消
      setActivePreset(null);
      setForm((f) => ({ ...f, damageLevel: 0, damageLocation: "", description: "" }));
      return;
    }
    setActivePreset(key);
    switch (key) {
      case "normal":
        setForm((f) => ({ ...f, damageLevel: 0, damageLocation: "", description: "外观正常" }));
        break;
      case "damage":
        setForm((f) => ({ ...f, damageLevel: f.damageLevel || 2, damageLocation: f.damageLocation || "外包装" }));
        break;
      case "quantity":
        setForm((f) => ({ ...f, damageLevel: 0, damageLocation: "", description: "" }));
        break;
      case "spec":
        setForm((f) => ({ ...f, damageLevel: 0, damageLocation: "", description: "" }));
        break;
      case "batch":
        setForm((f) => ({ ...f, damageLevel: 0, damageLocation: "", description: "" }));
        break;
    }
  }

  function updateField<K extends keyof ScanForm>(key: K, value: ScanForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

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
          damageLevel: form.damageLevel || undefined,
          damageLocation: form.damageLocation || undefined,
          estimatedAmount: Number(form.estimatedAmount) || 0,
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
        {/* 快速预设按钮栏 */}
        <div>
          <div className="mb-2 flex items-center gap-1 text-xs font-medium text-[var(--color-text-muted)]">
            <Zap className="h-3 w-3" /> 快速预设（可选）
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  activePreset === p.key
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                    : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]/40 hover:text-[var(--color-text-main)]"
                }`}
                title={p.hint}
              >
                {p.icon}
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 运单 + SKU 基础信息 */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium">运单 ID / 外部编码 *</span>
            <input
              value={form.shipmentId}
              onChange={(e) => updateField("shipmentId", e.target.value)}
              placeholder="输入 V2 运单 ID 或 externalCode"
              className="input-field mt-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">SKU 编码 *</span>
            <input
              value={form.skuCode}
              onChange={(e) => updateField("skuCode", e.target.value)}
              placeholder="如 SKU-001"
              className="input-field mt-1"
            />
          </label>
        </div>

        {/* 数量 + 规格 + 批次 */}
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className={`text-sm font-medium ${activePreset === "quantity" ? "text-[var(--color-primary)]" : ""}`}>
              实扫数量 {activePreset === "quantity" && "⚠"}
            </span>
            <input
              type="number"
              value={form.actualQuantity}
              onChange={(e) => updateField("actualQuantity", e.target.value)}
              placeholder="如 10"
              className={`input-field mt-1 ${activePreset === "quantity" ? "ring-2 ring-[var(--color-primary)]/30" : ""}`}
            />
          </label>
          <label className="block">
            <span className={`text-sm font-medium ${activePreset === "spec" ? "text-[var(--color-primary)]" : ""}`}>
              实扫规格 {activePreset === "spec" && "⚠"}
            </span>
            <input
              value={form.skuSpec}
              onChange={(e) => updateField("skuSpec", e.target.value)}
              placeholder="如 规格-A"
              className={`input-field mt-1 ${activePreset === "spec" ? "ring-2 ring-[var(--color-primary)]/30" : ""}`}
            />
          </label>
          <label className="block">
            <span className={`text-sm font-medium ${activePreset === "batch" ? "text-[var(--color-primary)]" : ""}`}>
              批次号 * {activePreset === "batch" && "⚠"}
            </span>
            <input
              value={form.batchNo}
              onChange={(e) => updateField("batchNo", e.target.value)}
              placeholder="如 BATCH-001"
              className={`input-field mt-1 ${activePreset === "batch" ? "ring-2 ring-[var(--color-primary)]/30" : ""}`}
            />
          </label>
        </div>

        {/* 设备 ID + 预估金额 */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium">设备 ID</span>
            <input
              value={form.deviceId}
              onChange={(e) => updateField("deviceId", e.target.value)}
              placeholder="如 PDA-01"
              className="input-field mt-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">预估赔付金额（元）</span>
            <input
              type="number"
              value={form.estimatedAmount}
              onChange={(e) => updateField("estimatedAmount", e.target.value)}
              placeholder="如 50.00"
              className="input-field mt-1"
              min="0"
              step="0.01"
            />
          </label>
        </div>

        {/* 异常观察区（仅异常时填写） */}
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-3">
          <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
            异常观察{activePreset && activePreset !== "normal" ? " — 已选「" + PRESETS.find((p) => p.key === activePreset)!.label + "」" : ""}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* 损伤等级选择器 */}
            <label className="flex flex-col gap-1">
              <span className={`text-xs ${activePreset === "damage" ? "text-[var(--color-primary)] font-medium" : "text-[var(--color-text-muted)]"}`}>
                损伤等级 {activePreset === "damage" && "⚠"}
              </span>
              <select
                value={form.damageLevel}
                onChange={(e) => updateField("damageLevel", Number(e.target.value))}
                className={`input-field text-sm ${activePreset === "damage" ? "ring-2 ring-[var(--color-primary)]/30" : ""}`}
              >
                {DAMAGE_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label} {l.desc}
                  </option>
                ))}
              </select>
            </label>

            {/* 损伤部位选择器 */}
            <label className="flex flex-col gap-1">
              <span className={`text-xs ${activePreset === "damage" ? "text-[var(--color-primary)] font-medium" : "text-[var(--color-text-muted)]"}`}>
                损伤部位
              </span>
              <select
                value={form.damageLocation}
                onChange={(e) => updateField("damageLocation", e.target.value)}
                className={`input-field text-sm ${form.damageLevel > 0 ? "ring-2 ring-[var(--color-primary)]/20" : ""}`}
              >
                {DAMAGE_LOCATIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* 补充描述 */}
          <label className="mt-3 block">
            <span className="text-xs text-[var(--color-text-muted)]">补充描述</span>
            <input
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="如 外包装边角有明显压痕、箱体潮湿"
              className="input-field mt-1 text-sm"
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
