"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Search, Send } from "lucide-react";
import { apiFetch, ApiError, useSession } from "@/components/shared/auth-context";
import { useToast } from "@/components/shared/toast";
import { formatDateTime } from "@/lib/utils";

interface V2Item {
  id: string;
  skuCode: string;
  skuName: string;
  skuQuantity: string;
  skuSpec: string | null;
}
interface V2Detail {
  id: string;
  externalCode: string | null;
  storeName: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  remark: string | null;
  skuCount: number;
  totalQuantity: string;
  batchId: string;
  submittedAt: string;
  items: V2Item[];
}
interface LookupResp {
  found: boolean;
  requestId: string;
  data: V2Detail | null;
}

const SUBTYPES = [
  { value: "loss", label: "丢件" },
  { value: "damage", label: "破损" },
  { value: "wrong_item", label: "错发" },
  { value: "missing_item", label: "少发" },
  { value: "delivery_failure", label: "配送失败" },
  { value: "address_error", label: "地址错误" },
  { value: "other", label: "其他" },
];

export default function NewTicketPage() {
  const { loading } = useSession();
  const router = useRouter();
  const toast = useToast();

  const [lookupType, setLookupType] = useState<"shipmentId" | "externalCode">("shipmentId");
  const [lookupValue, setLookupValue] = useState("");
  const [lookuping, setLookuping] = useState(false);
  const [detail, setDetail] = useState<V2Detail | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [subtype, setSubtype] = useState("");
  const [severity, setSeverity] = useState("low");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function doLookup() {
    if (!lookupValue.trim()) return;
    setLookuping(true);
    setDetail(null);
    setNotFound(false);
    setRequestId(null);
    try {
      const qs = lookupType === "shipmentId"
        ? `shipmentId=${encodeURIComponent(lookupValue.trim())}`
        : `externalCode=${encodeURIComponent(lookupValue.trim())}`;
      const r = await apiFetch<LookupResp>(`/api/waybills/lookup?${qs}`);
      setRequestId(r.requestId);
      if (r.found && r.data) {
        setDetail(r.data);
        if (!subtype) setSubtype("loss");
      } else {
        setNotFound(true);
      }
    } catch (e) {
      toast.showToast((e as Error).message, "error");
    } finally {
      setLookuping(false);
    }
  }

  async function submit() {
    if (!detail) {
      toast.showToast("请先查询运单", "error");
      return;
    }
    if (!subtype || !severity || !description.trim()) {
      toast.showToast("请填写子类型、严重度、问题描述", "error");
      return;
    }
    setSubmitting(true);
    try {
      const r = await apiFetch<{ id: string; ticketNo: string; routeReason: string; currentLevel: number }>(
        "/api/tickets",
        {
          method: "POST",
          body: JSON.stringify({
            shipmentId: detail.id,
            subtype,
            severity,
            estimatedAmount: Number(amount) || 0,
            description: description.trim(),
          }),
        }
      );
      toast.showToast(`工单 ${r.ticketNo} 已创建（${r.routeReason}）`, "success");
      router.push(`/tickets/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "DUPLICATE_OPEN_TICKET" || e.code === "WAYBILL_NOT_FOUND")) {
        toast.showToast(e.message, "error");
      } else {
        toast.showToast((e as Error).message, "error");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <Link href="/tickets" className="btn-ghost mb-2 no-underline">
        <ArrowLeft className="h-4 w-4" /> 返回工单列表
      </Link>
      <h1 className="text-xl font-bold text-[var(--color-text-main)]">上报物流异常</h1>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
        实时调用 V2 校验运单存在；运单不存在则不创建工单（§16.1）。
      </p>

      <div className="card mt-4">
        <h2 className="mb-3 text-base font-semibold text-[var(--color-text-main)]">1. 查询运单</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={lookupType}
            onChange={(e) => setLookupType(e.target.value as "shipmentId" | "externalCode")}
            className="input-field !w-auto"
          >
            <option value="shipmentId">按运单 ID</option>
            <option value="externalCode">按外部编码</option>
          </select>
          <input
            value={lookupValue}
            onChange={(e) => setLookupValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doLookup(); }}
            placeholder={lookupType === "shipmentId" ? "shipment UUID" : "如 WB2024001"}
            className="input-field"
          />
          <button onClick={doLookup} disabled={lookuping || !lookupValue.trim()} className="btn-primary">
            <Search className="h-4 w-4" /> {lookuping ? "查询中…" : "查询 V2"}
          </button>
        </div>

        {notFound && (
          <div className="alert alert-danger mt-3">
            V2 未找到该运单（requestId={requestId ?? "-"}），不会创建工单。
            可前往 <Link href="/integrations" className="underline">接口监控</Link> 查看失败日志。
          </div>
        )}

        {detail && (
          <div className="mt-4">
            <div className="alert alert-success">
              ✓ 已查到运单 · requestId={requestId} · 共 {detail.skuCount} 个 SKU · 总数 {detail.totalQuantity}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="运单 ID" value={<code className="text-xs">{detail.id}</code>} />
              <Field label="外部编码" value={detail.externalCode ?? "-"} />
              <Field label="店铺" value={detail.storeName ?? "-"} />
              <Field label="收货人" value={detail.receiverName ?? "-"} />
              <Field label="收货电话（脱敏）" value={detail.receiverPhone ?? "-"} />
              <Field label="收货地址" value={detail.receiverAddress ?? "-"} />
              <Field label="批次" value={detail.batchId} />
              <Field label="提交时间" value={formatDateTime(detail.submittedAt)} />
            </div>
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-main)]">SKU 明细</h3>
              <div className="table-wrapper">
                <table className="table-styled">
                  <thead>
                    <tr><th>SKU 编码</th><th>名称</th><th>数量</th><th>规格</th></tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it) => (
                      <tr key={it.id}>
                        <td className="font-mono text-xs">{it.skuCode}</td>
                        <td>{it.skuName}</td>
                        <td>{it.skuQuantity}</td>
                        <td>{it.skuSpec ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {detail && (
        <div className="card mt-4">
          <h2 className="mb-3 text-base font-semibold text-[var(--color-text-main)]">2. 填写异常信息</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm text-[var(--color-text-secondary)]">物流异常子类型 *</span>
              <select value={subtype} onChange={(e) => setSubtype(e.target.value)} className="input-field">
                <option value="">请选择</option>
                {SUBTYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-[var(--color-text-secondary)]">严重度 *</span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="input-field">
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高（强制二级审批）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-[var(--color-text-secondary)]">预估赔付金额（元）</span>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="金额 > 1000 自动升级二级审批"
                className="input-field"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-sm text-[var(--color-text-secondary)]">问题描述 *</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="请描述异常经过、责任判断、客户诉求等"
                className="input-field"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Link href="/tickets" className="btn-ghost no-underline">取消</Link>
            <button onClick={submit} disabled={submitting} className="btn-primary">
              <Send className="h-4 w-4" /> {submitting ? "提交中…" : "提交工单"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      <span className="text-sm text-[var(--color-text-main)]">{value}</span>
    </div>
  );
}
