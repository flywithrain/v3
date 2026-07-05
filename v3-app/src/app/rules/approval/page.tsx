"use client";

import { useEffect, useState, useCallback } from "react";
import { Settings, Pencil } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { useToast } from "@/components/shared/toast";
import { formatDateTime } from "@/lib/utils";

interface ApprovalRule {
  id: string;
  name: string;
  category: string;
  conditionConfig: unknown;
  targetLevel: number;
  timeoutHours: number | null;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

function prettyCond(c: unknown): string {
  if (!c || typeof c !== "object") return "{}";
  return JSON.stringify(c);
}

export default function ApprovalRulesPage() {
  const { user, loading } = useSession();
  const toast = useToast();
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [loading2, setLoading2] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ targetLevel: number; timeoutHours: string; enabled: boolean; priority: string }>({
    targetLevel: 1,
    timeoutHours: "",
    enabled: true,
    priority: "100",
  });

  const load = useCallback(async () => {
    setLoading2(true);
    try {
      const r = await apiFetch<ApprovalRule[]>("/api/rules/approval");
      setRules(r);
    } catch (e) {
      toast.showToast((e as Error).message, "error");
    } finally {
      setLoading2(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const isAdmin = user?.roleCodes.includes("admin") ?? false;

  function startEdit(r: ApprovalRule) {
    setEditingId(r.id);
    setDraft({
      targetLevel: r.targetLevel,
      timeoutHours: r.timeoutHours == null ? "" : String(r.timeoutHours),
      enabled: r.enabled,
      priority: String(r.priority),
    });
  }

  async function save(r: ApprovalRule) {
    try {
      await apiFetch("/api/rules/approval", {
        method: "POST",
        body: JSON.stringify({
          id: r.id,
          name: r.name,
          category: r.category,
          conditionConfig: r.conditionConfig,
          targetLevel: Number(draft.targetLevel),
          timeoutHours: draft.timeoutHours === "" ? null : Number(draft.timeoutHours),
          enabled: draft.enabled,
          priority: Number(draft.priority),
        }),
      });
      toast.showToast("规则已更新", "success");
      setEditingId(null);
      await load();
    } catch (e) {
      toast.showToast((e as Error).message, "error");
    }
  }

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">审批规则</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          按金额阈值 / 严重度路由审批层级（§6.1）{!isAdmin && "· 仅 admin 可修改"}
        </p>
      </header>

      {loading2 && rules.length === 0 && (
        <div className="text-sm text-[var(--color-text-muted)]">加载中…</div>
      )}

      <div className="card !p-0">
        <div className="table-wrapper">
          <table className="table-styled">
            <thead>
              <tr>
                <th>优先级</th><th>名称</th><th>类别</th><th>条件</th>
                <th>目标层级</th><th>超时(h)</th><th>启用</th><th>更新</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    {editingId === r.id ? (
                      <input
                        type="number"
                        value={draft.priority}
                        onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                        className="input-field !w-20 !py-1"
                      />
                    ) : r.priority}
                  </td>
                  <td>{r.name}</td>
                  <td>{r.category}</td>
                  <td className="font-mono text-xs">{prettyCond(r.conditionConfig)}</td>
                  <td>
                    {editingId === r.id ? (
                      <select
                        value={draft.targetLevel}
                        onChange={(e) => setDraft({ ...draft, targetLevel: Number(e.target.value) })}
                        className="input-field !w-auto !py-1"
                      >
                        <option value={1}>一级</option>
                        <option value={2}>二级</option>
                      </select>
                    ) : (
                      <span className="tag tag-teal">{r.targetLevel} 级</span>
                    )}
                  </td>
                  <td>
                    {editingId === r.id ? (
                      <input
                        type="number"
                        value={draft.timeoutHours}
                        onChange={(e) => setDraft({ ...draft, timeoutHours: e.target.value })}
                        placeholder="留空"
                        className="input-field !w-20 !py-1"
                      />
                    ) : r.timeoutHours ?? "-"}
                  </td>
                  <td>
                    {editingId === r.id ? (
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                      />
                    ) : r.enabled ? (
                      <span className="tag tag-green">启用</span>
                    ) : (
                      <span className="tag tag-gray">停用</span>
                    )}
                  </td>
                  <td className="text-xs">{formatDateTime(r.updatedAt)}</td>
                  <td>
                    {editingId === r.id ? (
                      <div className="flex gap-1">
                        <button onClick={() => save(r)} className="btn-primary !py-1 !px-3">保存</button>
                        <button onClick={() => setEditingId(null)} className="btn-ghost !py-1 !px-3">取消</button>
                      </div>
                    ) : (
                      isAdmin ? (
                        <button
                          onClick={() => startEdit(r)}
                          className="btn-ghost !py-1"
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      ) : (
                        <Settings className="h-4 w-4 text-[var(--color-text-muted)]" />
                      )
                    )}
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
