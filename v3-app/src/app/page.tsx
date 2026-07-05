"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckSquare, AlertTriangle, FilePlus, Clock, RefreshCw } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { formatDateTime } from "@/lib/utils";

interface DashboardData {
  myApproveCount: number;
  qcHoldCount: number;
  todayNew: number;
  dueSoon: number;
  v2LastSyncAt: string | null;
  v2RecentSuccessRate: number | null;
  v2RecentCount: number;
  currentUser: { id: string; name: string; roleCodes: string[] };
}

export default function HomePage() {
  const { user, loading } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    apiFetch<DashboardData>("/api/dashboard")
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, [user]);

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;
  if (!user) {
    return (
      <div className="p-6">
        <div className="alert alert-warning">
          请在右上角下拉选择一个用户角色以模拟登录。
        </div>
      </div>
    );
  }

  const successRatePct =
    data?.v2RecentSuccessRate == null
      ? null
      : Math.round(data.v2RecentSuccessRate * 100);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">仪表盘</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          欢迎回来，{user.name}。本轮交付：人工物流异常 上报 → 分级审批 → 执行联动 核心闭环。
        </p>
      </header>

      {err && <div className="alert alert-danger mb-4">加载失败：{err}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/approvals" className="stat-card no-underline hover:shadow-lg">
          <div className="flex items-center gap-2 text-[var(--color-primary)]">
            <CheckSquare className="h-5 w-5" />
            <span className="stat-label">待我审批</span>
          </div>
          <div className="stat-value">{data?.myApproveCount ?? "-"}</div>
        </Link>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-[var(--color-warning)]">
            <AlertTriangle className="h-5 w-5" />
            <span className="stat-label">品控暂扣</span>
          </div>
          <div className="stat-value">{data?.qcHoldCount ?? 0}</div>
          <span className="text-xs text-[var(--color-text-muted)]">本轮未含品控流程</span>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-[var(--color-primary)]">
            <FilePlus className="h-5 w-5" />
            <span className="stat-label">今日新增异常</span>
          </div>
          <div className="stat-value">{data?.todayNew ?? "-"}</div>
        </div>

        <div className="stat-card">
          <div className="flex items-center gap-2 text-[var(--color-warning)]">
            <Clock className="h-5 w-5" />
            <span className="stat-label">即将超时(4h内)</span>
          </div>
          <div className="stat-value">{data?.dueSoon ?? "-"}</div>
        </div>
      </div>

      <div className="mt-4 card">
        <div className="mb-2 flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-[var(--color-primary)]" />
          <h2 className="text-base font-semibold text-[var(--color-text-main)]">V2 集成近期健康</h2>
        </div>
        {data?.v2LastSyncAt ? (
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-[var(--color-text-secondary)]">
            <span>
              末次同步：<b className="text-[var(--color-text-main)]">{formatDateTime(data.v2LastSyncAt)}</b>
            </span>
            <span>
              近期成功率：
              <b className={successRatePct == null ? "" : successRatePct >= 95 ? "text-[var(--color-success)]" : successRatePct >= 80 ? "text-[var(--color-warning)]" : "text-[var(--color-danger)]"}>
                {successRatePct == null ? "无数据" : `${successRatePct}%`}
              </b>
            </span>
            <span>
              统计样本：<b>{data.v2RecentCount}</b> 条
            </span>
            <Link href="/integrations" className="text-[var(--color-primary)] no-underline hover:underline">
              查看接口监控 →
            </Link>
          </div>
        ) : (
          <div className="text-sm text-[var(--color-text-muted)]">暂无 V2 集成调用记录。</div>
        )}
      </div>

      <div className="mt-4 card">
        <h2 className="mb-2 text-base font-semibold text-[var(--color-text-main)]">快速入口</h2>
        <div className="flex flex-wrap gap-2">
          <Link href="/tickets/new" className="btn-primary no-underline">上报物流异常</Link>
          <Link href="/tickets" className="btn-outline no-underline">工单列表</Link>
          <Link href="/approvals" className="btn-outline no-underline">待我审批</Link>
          <Link href="/rules/approval" className="btn-ghost no-underline">审批规则</Link>
        </div>
      </div>
    </div>
  );
}
