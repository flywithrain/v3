"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckSquare } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { formatDateTime } from "@/lib/utils";
import { StatusBadge, SeverityBadge, subtypeLabel } from "@/components/shared/badges";

interface TicketItem {
  id: string;
  ticketNo: string;
  source: string;
  subtype: string;
  severity: string;
  estimatedAmount: string;
  status: string;
  currentLevel: number | null;
  externalCode: string | null;
  dueAt: string | null;
  createdAt: string;
  version: number;
}
interface ListResp { items: TicketItem[]; total: number; page: number; pageSize: number; }

export default function ApprovalsPage() {
  const { user, loading } = useSession();
  const [items, setItems] = useState<TicketItem[]>([]);
  const [loading2, setLoading2] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setLoading2(true);
    setErr(null);
    // 拉一级和二级审批中的工单，再按角色 + 排除自己上报的过滤
    Promise.all([
      apiFetch<ListResp>("/api/tickets?status=level1_reviewing&pageSize=100"),
      apiFetch<ListResp>("/api/tickets?status=level2_reviewing&pageSize=100"),
    ])
      .then(([a, b]) => {
        const all = [...a.items, ...b.items];
        const isL1 = user.roleCodes.includes("level1_approver") || user.roleCodes.includes("admin");
        const isL2 = user.roleCodes.includes("level2_approver") || user.roleCodes.includes("admin");
        const filtered = all.filter((t) => {
          // 自批自核禁止
          if (t.status === "level1_reviewing") return isL1;
          if (t.status === "level2_reviewing") return isL2;
          return false;
        });
        setItems(filtered);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading2(false));
  }, [user]);

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;
  if (!user) return <div className="p-6"><div className="alert alert-warning">请先在右上角选择用户登录。</div></div>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">待我审批</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          当前角色：{user.roleCodes.join(", ")} · 自批自核已自动剔除
        </p>
      </header>

      {err && <div className="alert alert-danger mb-4">加载失败：{err}</div>}

      <div className="card !p-0">
        <div className="table-wrapper">
          <table className="table-styled">
            <thead>
              <tr>
                <th>工单号</th><th>子类型</th><th>严重度</th><th>金额</th>
                <th>状态</th><th>截止</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading2 && <tr><td colSpan={7} className="text-center text-[var(--color-text-muted)]">加载中…</td></tr>}
              {!loading2 && items.length === 0 && (
                <tr><td colSpan={7} className="text-center text-[var(--color-text-muted)]">暂无待审批工单</td></tr>
              )}
              {!loading2 && items.map((t) => (
                <tr key={t.id}>
                  <td className="font-mono text-xs">{t.ticketNo}</td>
                  <td>{subtypeLabel(t.subtype)}</td>
                  <td><SeverityBadge severity={t.severity} /></td>
                  <td>{t.estimatedAmount}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="text-xs">{formatDateTime(t.dueAt)}</td>
                  <td>
                    <Link href={`/tickets/${t.id}`} className="text-[var(--color-primary)] no-underline hover:underline">
                      <CheckSquare className="inline h-4 w-4" /> 去审批
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
