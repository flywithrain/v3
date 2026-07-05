"use client";

import { useEffect, useState } from "react";
import { Boxes, ArrowDownRight, ArrowUpRight } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { formatDateTime } from "@/lib/utils";

interface InventoryItem {
  id: string;
  skuCode: string;
  skuName: string | null;
  batchNo: string;
  availableQuantity: string;
  lockedQuantity: string;
  status: string;
  updatedAt: string;
}
interface Movement {
  id: string;
  ticketId: string | null;
  approvalRecordId: string | null;
  skuCode: string;
  batchNo: string;
  movementType: string;
  quantity: string;
  createdAt: string;
}
interface Resp { items: InventoryItem[]; movements: Movement[]; }

const STATUS_LABELS: Record<string, string> = {
  normal: "正常",
  locked: "锁定",
  returned: "已退货",
  scrapped: "已报废",
};

const MOVEMENT_LABELS: Record<string, { label: string; cls: string; sign: string }> = {
  outbound: { label: "出库", cls: "text-[var(--color-danger)]", sign: "-" },
  return_in: { label: "退货入库", cls: "text-[var(--color-success)]", sign: "+" },
  lock: { label: "锁定", cls: "text-[var(--color-warning)]", sign: "-" },
  unlock: { label: "解锁", cls: "text-[var(--color-success)]", sign: "+" },
  scrap: { label: "报废", cls: "text-[var(--color-danger)]", sign: "-" },
  repurchase: { label: "补货", cls: "text-[var(--color-success)]", sign: "+" },
};

export default function InventoryPage() {
  const { loading } = useSession();
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"items" | "movements">("items");

  useEffect(() => {
    apiFetch<Resp>("/api/inventory").then(setData).catch((e) => setErr((e as Error).message));
  }, []);

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">库存与流水</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">审批通过后执行联动写入（§11.9 / §12）</p>
      </header>

      {err && <div className="alert alert-danger mb-4">加载失败：{err}</div>}

      <div className="mb-3 inline-flex rounded-md border border-[var(--color-border)] bg-white p-0.5">
        <button
          onClick={() => setTab("items")}
          className={tab === "items" ? "btn-primary !py-1.5" : "btn-ghost !py-1.5"}
        >
          <Boxes className="h-4 w-4" /> 库存批次
        </button>
        <button
          onClick={() => setTab("movements")}
          className={tab === "movements" ? "btn-primary !py-1.5" : "btn-ghost !py-1.5"}
        >
          流水 ({data?.movements.length ?? 0})
        </button>
      </div>

      {!data && <div className="text-sm text-[var(--color-text-muted)]">加载中…</div>}

      {data && tab === "items" && (
        <div className="card !p-0">
          <div className="table-wrapper">
            <table className="table-styled">
              <thead>
                <tr>
                  <th>SKU</th><th>名称</th><th>批次</th>
                  <th>可用</th><th>锁定</th><th>状态</th><th>更新</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-[var(--color-text-muted)]">暂无库存</td></tr>
                )}
                {data.items.map((it) => (
                  <tr key={it.id}>
                    <td className="font-mono text-xs">{it.skuCode}</td>
                    <td>{it.skuName ?? "-"}</td>
                    <td className="text-xs">{it.batchNo}</td>
                    <td>{it.availableQuantity}</td>
                    <td>{it.lockedQuantity}</td>
                    <td>
                      <span className="tag tag-gray">{STATUS_LABELS[it.status] ?? it.status}</span>
                    </td>
                    <td className="text-xs">{formatDateTime(it.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && tab === "movements" && (
        <div className="card !p-0">
          <div className="table-wrapper">
            <table className="table-styled">
              <thead>
                <tr>
                  <th>SKU</th><th>批次</th><th>类型</th><th>数量</th>
                  <th>工单</th><th>审批记录</th><th>时间</th>
                </tr>
              </thead>
              <tbody>
                {data.movements.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-[var(--color-text-muted)]">暂无流水</td></tr>
                )}
                {data.movements.map((m) => {
                  const meta = MOVEMENT_LABELS[m.movementType] ?? { label: m.movementType, cls: "", sign: "" };
                  return (
                    <tr key={m.id}>
                      <td className="font-mono text-xs">{m.skuCode}</td>
                      <td className="text-xs">{m.batchNo}</td>
                      <td>
                        {meta.sign === "-" ? (
                          <ArrowDownRight className="inline h-3.5 w-3.5" />
                        ) : meta.sign === "+" ? (
                          <ArrowUpRight className="inline h-3.5 w-3.5" />
                        ) : null}{" "}
                        {meta.label}
                      </td>
                      <td className={meta.cls}>{meta.sign}{m.quantity}</td>
                      <td className="font-mono text-xs">{m.ticketId?.slice(0, 8) ?? "-"}</td>
                      <td className="font-mono text-xs">{m.approvalRecordId?.slice(0, 8) ?? "-"}</td>
                      <td className="text-xs">{formatDateTime(m.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
