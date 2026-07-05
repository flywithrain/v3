"use client";

import { useEffect, useState, useCallback } from "react";
import { Search, Activity } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { formatDateTime } from "@/lib/utils";

interface LogItem {
  id: string;
  requestId: string;
  direction: string;
  endpoint: string;
  method: string;
  statusCode: number | null;
  success: boolean;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}
interface LogsResp {
  page: number;
  pageSize: number;
  items: LogItem[];
  summary: { recentCount: number; successRate: number | null; lastSyncAt: string | null };
}

export default function IntegrationsPage() {
  const { loading } = useSession();
  const [items, setItems] = useState<LogItem[]>([]);
  const [summary, setSummary] = useState<LogsResp["summary"] | null>(null);
  const [requestId, setRequestId] = useState("");
  const [requestIdInput, setRequestIdInput] = useState("");
  const [failOnly, setFailOnly] = useState(false);
  const [loading2, setLoading2] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading2(true);
    setErr(null);
    const qs = new URLSearchParams({ page: "1", pageSize: "50" });
    if (requestId) qs.set("requestId", requestId);
    if (failOnly) qs.set("success", "false");
    try {
      const r = await apiFetch<LogsResp>(`/api/integrations/logs?${qs.toString()}`);
      setItems(r.items);
      setSummary(r.summary);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading2(false);
    }
  }, [requestId, failOnly]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;

  const ratePct = summary?.successRate == null ? null : Math.round(summary.successRate * 100);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">接口监控</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">V3 → V2 跨系统调用日志（§11.8）</p>
      </header>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="stat-card">
          <span className="stat-label">近期成功率</span>
          <span className="stat-value">
            {ratePct == null ? "—" : `${ratePct}%`}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">末次同步</span>
          <span className="stat-value text-base">{formatDateTime(summary?.lastSyncAt)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">统计样本</span>
          <span className="stat-value">{summary?.recentCount ?? 0}</span>
        </div>
      </div>

      <div className="card mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-1 items-center gap-2">
          <Search className="h-4 w-4 text-[var(--color-text-muted)]" />
          <input
            value={requestIdInput}
            onChange={(e) => setRequestIdInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { setRequestId(requestIdInput.trim()); } }}
            placeholder="按 requestId 精确查询"
            className="input-field"
          />
          <button onClick={() => setRequestId(requestIdInput.trim())} className="btn-outline">查询</button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={failOnly} onChange={(e) => setFailOnly(e.target.checked)} />
          仅看失败
        </label>
        {(requestId || failOnly) && (
          <button
            onClick={() => { setRequestId(""); setRequestIdInput(""); setFailOnly(false); }}
            className="btn-ghost"
          >清除</button>
        )}
      </div>

      {err && <div className="alert alert-danger mb-4">加载失败：{err}</div>}

      <div className="card !p-0">
        <div className="table-wrapper">
          <table className="table-styled">
            <thead>
              <tr>
                <th>requestId</th><th>方向</th><th>接口</th><th>方法</th>
                <th>HTTP</th><th>耗时</th><th>结果</th><th>错误</th><th>时间</th>
              </tr>
            </thead>
            <tbody>
              {loading2 && <tr><td colSpan={9} className="text-center text-[var(--color-text-muted)]">加载中…</td></tr>}
              {!loading2 && items.length === 0 && (
                <tr><td colSpan={9} className="text-center text-[var(--color-text-muted)]">暂无记录</td></tr>
              )}
              {!loading2 && items.map((l) => (
                <tr key={l.id}>
                  <td className="font-mono text-xs">{l.requestId}</td>
                  <td>{l.direction}</td>
                  <td className="text-xs">{l.endpoint}</td>
                  <td>{l.method}</td>
                  <td>{l.statusCode ?? "-"}</td>
                  <td>{l.durationMs}ms</td>
                  <td>
                    {l.success
                      ? <span className="tag tag-green">成功</span>
                      : <span className="tag tag-red">失败</span>}
                  </td>
                  <td className="text-xs">
                    {l.errorCode ? `${l.errorCode}${l.errorMessage ? " · " + l.errorMessage : ""}` : "-"}
                  </td>
                  <td className="text-xs">{formatDateTime(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <Activity className="h-4 w-4" /> 本轮 V2 不可用降级：列表/详情可读本地快照；新建异常被拒。
      </div>
    </div>
  );
}
