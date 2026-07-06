"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Search, Plus, FileText, AlertTriangle, Clock } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { formatDateTime, isTimeoutUrgent, isTimeoutOverdue } from "@/lib/utils";
import { StatusBadge, SeverityBadge, subtypeLabel, sourceLabel } from "@/components/shared/badges";

interface TicketItem {
  id: string;
  ticketNo: string;
  source: string;
  category: string;
  subtype: string;
  severity: string;
  estimatedAmount: string;
  status: string;
  currentLevel: number | null;
  externalCode: string | null;
  v2ShipmentId: string | null;
  assignedApproverName: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface ListResp {
  page: number;
  pageSize: number;
  total: number;
  items: TicketItem[];
}

const SOURCE_FILTERS = [
  { value: "", label: "全部来源" },
  { value: "manual_report", label: "人工上报" },
  { value: "scan_qc", label: "扫码品控" },
];

const CATEGORY_FILTERS = [
  { value: "", label: "全部大类" },
  { value: "logistics", label: "物流异常" },
  { value: "quality_control", label: "品控异常" },
];

const SUBTYPE_FILTERS = [
  { value: "", label: "全部子类型" },
  { value: "lost", label: "丢件" },
  { value: "damaged", label: "破损" },
  { value: "rejected", label: "拒收" },
  { value: "timeout_unsigned", label: "超时未签收" },
  { value: "address_error", label: "地址错误" },
  { value: "quantity_mismatch", label: "数量差异" },
  { value: "damage", label: "外观破损" },
  { value: "spec_mismatch", label: "规格不符" },
  { value: "label_mismatch", label: "标签不一致" },
  { value: "batch_risk", label: "批次风险" },
];
const STATUS_FILTERS = [
  { value: "", label: "全部状态" },
  { value: "pending_review", label: "待重审" },
  { value: "level1_reviewing", label: "一级审批中" },
  { value: "level2_reviewing", label: "二级审批中" },
  { value: "executing", label: "执行中" },
  { value: "rejected", label: "已拒绝(可重提)" },
  { value: "closed_rejected_limit", label: "重提上限已关闭" },
  { value: "completed", label: "已完成" },
  { value: "closed", label: "已关闭" },
];

export default function TicketsPage() {
  const { loading } = useSession();
  const [items, setItems] = useState<TicketItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [status, setStatus] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subtypeFilter, setSubtypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [loading2, setLoading2] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading2(true);
    setErr(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status) params.set("status", status);
    if (sourceFilter) params.set("source", sourceFilter);
    if (categoryFilter) params.set("category", categoryFilter);
    if (subtypeFilter) params.set("subtype", subtypeFilter);
    if (search) params.set("search", search);
    try {
      const r = await apiFetch<ListResp>(`/api/tickets?${params.toString()}`);
      setItems(r.items);
      setTotal(r.total);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading2(false);
    }
  }, [page, pageSize, status, sourceFilter, categoryFilter, subtypeFilter, search]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--color-text-main)]">工单列表</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">共 {total} 条 · 第 {page}/{totalPages} 页</p>
        </div>
        <Link href="/tickets/new" className="btn-primary no-underline">
          <Plus className="h-4 w-4" /> 上报异常
        </Link>
      </header>

      <div className="card mb-4 flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="input-field !w-auto"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => {
            setSourceFilter(e.target.value);
            setPage(1);
          }}
          className="input-field !w-auto"
        >
          {SOURCE_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            setPage(1);
          }}
          className="input-field !w-auto"
        >
          {CATEGORY_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          value={subtypeFilter}
          onChange={(e) => {
            setSubtypeFilter(e.target.value);
            setPage(1);
          }}
          className="input-field !w-auto"
        >
          {SUBTYPE_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <div className="flex flex-1 items-center gap-2">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSearch(searchInput.trim());
                setPage(1);
              }
            }}
            placeholder="按工单号或运单 ID 搜索"
            className="input-field"
          />
          <button
            onClick={() => {
              setSearch(searchInput.trim());
              setPage(1);
            }}
            className="btn-outline"
          >
            <Search className="h-4 w-4" /> 搜索
          </button>
          {search && (
            <button
              onClick={() => {
                setSearch("");
                setSearchInput("");
                setPage(1);
              }}
              className="btn-ghost"
            >
              清除
            </button>
          )}
        </div>
      </div>

      {err && <div className="alert alert-danger mb-4">加载失败：{err}</div>}

      <div className="card !p-0">
        <div className="table-wrapper">
          <table className="table-styled">
            <thead>
              <tr>
                <th>工单号</th>
                <th>来源</th>
                <th>子类型</th>
                <th>严重度</th>
                <th>层级</th>
                <th>预估金额</th>
                <th>外部编码</th>
                <th>状态</th>
                <th>截止时间</th>
                <th>创建</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading2 && (
                <tr><td colSpan={11} className="text-center text-[var(--color-text-muted)]">加载中…</td></tr>
              )}
              {!loading2 && items.length === 0 && (
                <tr><td colSpan={11} className="text-center text-[var(--color-text-muted)]">暂无工单</td></tr>
              )}
              {!loading2 && items.map((t) => {
                const urgent = isTimeoutUrgent(t.dueAt);
                const overdue = isTimeoutOverdue(t.dueAt);
                const rowClass = overdue ? "bg-red-50" : urgent ? "bg-orange-50" : "";
                return (
                <tr key={t.id} className={rowClass}>
                  <td className="font-mono text-xs">{t.ticketNo}</td>
                  <td>{sourceLabel(t.source)}</td>
                  <td>{subtypeLabel(t.subtype)}</td>
                  <td><SeverityBadge severity={t.severity} /></td>
                  <td>{t.currentLevel != null ? `${t.currentLevel} 级` : "-"}</td>
                  <td>{t.estimatedAmount}</td>
                  <td className="font-mono text-xs">{t.externalCode ?? "-"}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="text-xs">
                    <span className="inline-flex items-center gap-1">
                      {formatDateTime(t.dueAt)}
                      {overdue && <AlertTriangle className="h-3 w-3 text-red-500" title="已超时" />}
                      {!overdue && urgent && <Clock className="h-3 w-3 text-orange-500" title="即将超时" />}
                    </span>
                  </td>
                  <td className="text-xs">{formatDateTime(t.createdAt)}</td>
                  <td>
                    <Link href={`/tickets/${t.id}`} className="text-[var(--color-primary)] no-underline hover:underline">
                      <FileText className="inline h-4 w-4" /> 详情
                    </Link>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-2">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="btn-ghost"
        >
          上一页
        </button>
        <span className="text-sm text-[var(--color-text-secondary)]">{page} / {totalPages}</span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="btn-ghost"
        >
          下一页
        </button>
      </div>
    </div>
  );
}
