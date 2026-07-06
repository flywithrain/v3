"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle, XCircle, Shield } from "lucide-react";
import { apiFetch, useSession, ROLE_LABELS } from "@/components/shared/auth-context";
import { useToast } from "@/components/shared/toast";
import { formatDateTime } from "@/lib/utils";

interface UserRow {
  id: string;
  name: string;
  roleCodes: string[];
  enabled: boolean;
}

export default function AdminUsersPage() {
  const { user, loading: sessLoading } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<UserRow[]>("/api/users");
      setRows(data);
    } catch (e) {
      toast.showToast("加载用户列表失败：" + (e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleEnabled = async (target: UserRow) => {
    setBusyIds((prev) => new Set(prev).add(target.id));
    try {
      await apiFetch(`/api/users/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !target.enabled }),
      });
      toast.showToast(
        `${target.name} 已${target.enabled ? "禁用" : "启用"}`,
        "success"
      );
      setRows((prev) =>
        prev.map((r) => (r.id === target.id ? { ...r, enabled: !r.enabled } : r))
      );
    } catch (e) {
      toast.showToast("操作失败：" + (e as Error).message, "error");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
    }
  };

  if (sessLoading || loading) {
    return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;
  }

  if (!user?.roleCodes.includes("admin")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="alert alert-danger">仅管理员可访问此页面</div>
        <Link href="/" className="btn-ghost mt-3 no-underline">返回首页</Link>
      </div>
    );
  }

  const enabledCount = rows.filter((r) => r.enabled).length;
  const disabledCount = rows.length - enabledCount;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <Link href="/" className="btn-ghost mb-4 no-underline">
        <ArrowLeft className="h-4 w-4" /> 返回首页
      </Link>

      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold text-[var(--color-text-main)]">
              <Shield className="h-5 w-5 text-[var(--color-primary)]" /> 用户管理
            </h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              共 {rows.length} 个用户 · 已启用 {enabledCount} · 已禁用 {disabledCount}
            </p>
          </div>
        </div>

        <div className="table-wrapper mt-3">
          <table className="table-styled">
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isSelf = r.id === user.id;
                const busy = busyIds.has(r.id);
                return (
                  <tr key={r.id} className={r.enabled ? "" : "opacity-50"}>
                    <td className="font-medium">
                      {r.name}
                      {isSelf && (
                        <span className="ml-2 tag tag-teal text-xs">当前</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {r.roleCodes.map((rc) => (
                          <span key={rc} className="tag tag-gray text-xs">
                            {ROLE_LABELS[rc] ?? rc}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {r.enabled ? (
                        <span className="flex items-center gap-1 text-sm text-green-600">
                          <CheckCircle className="h-3.5 w-3.5" /> 启用
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-sm text-red-500">
                          <XCircle className="h-3.5 w-3.5" /> 禁用
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      <button
                        onClick={() => toggleEnabled(r)}
                        disabled={busy || isSelf}
                        title={isSelf ? "不能禁用自己" : r.enabled ? "禁用" : "启用"}
                        className={
                          isSelf
                            ? "btn-ghost text-xs cursor-not-allowed"
                            : r.enabled
                              ? "btn-danger text-xs"
                              : "btn-primary text-xs"
                        }
                      >
                        {busy ? "处理中…" : r.enabled ? "禁用" : "启用"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
