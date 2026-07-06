"use client";

import { useEffect, useState, useCallback } from "react";
import { ShieldAlert, Pencil } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { useToast } from "@/components/shared/toast";
import { formatDateTime } from "@/lib/utils";

interface QcRule {
  id: string;
  name: string;
  subtype: string;
  conditionType: string;
  conditionConfig: unknown;
  severity: string;
  autoCreateTicket: boolean;
  defaultApprovalLevel: number;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

function prettyCond(c: unknown): string {
  if (!c || typeof c !== "object") return "{}";
  return JSON.stringify(c);
}

const SUBTYPE_LABELS: Record<string, string> = {
  quantity_mismatch: "数量不符",
  damage: "外观破损",
  spec_mismatch: "规格不符",
  label_mismatch: "标签错误",
  batch_risk: "批次异常",
};

const COND_TYPE_LABELS: Record<string, string> = {
  quantity_diff: "数量差异%",
  damage_level: "破损等级",
  spec_mismatch: "规格比对",
  label_mismatch: "标签SKU比对",
  batch_risk: "批次风险命中",
};

export default function QcRulesPage() {
  const { user, loading } = useSession();
  const toast = useToast();
  const [rules, setRules] = useState<QcRule[]>([]);
  const [loadingRules, setLoadingRules] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ severity: string; enabled: boolean; priority: string }>({
    severity: "medium",
    enabled: true,
    priority: "100",
  });

  const load = useCallback(async () => {
    setLoadingRules(true);
    try {
      const r = await apiFetch<QcRule[]>("/api/rules/qc");
      setRules(r);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) {
        toast.showToast((e as Error).message, "error");
      }
    } finally {
      setLoadingRules(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const isAdmin = user?.roleCodes.includes("admin") ?? false;

  function startEdit(r: QcRule) {
    setEditingId(r.id);
    setDraft({
      severity: r.severity,
      enabled: r.enabled,
      priority: String(r.priority),
    });
  }

  async function save(r: QcRule) {
    try {
      await apiFetch("/api/rules/qc", {
        method: "POST",
        body: JSON.stringify({
          id: r.id,
          name: r.name,
          subtype: r.subtype,
          conditionType: r.conditionType,
          conditionConfig: r.conditionConfig,
          severity: draft.severity,
          autoCreateTicket: r.autoCreateTicket,
          defaultApprovalLevel: r.defaultApprovalLevel,
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
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">品控规则引擎</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          可配置的品控触发条件（§6.5）{!isAdmin && "· 仅 admin 可修改"}
        </p>
      </header>

      {loadingRules && rules.length === 0 && (
        <div className="text-sm text-[var(--color-text-muted)]">加载中…</div>
      )}

      <div className="card !p-0">
        <div className="table-wrapper">
          <table className="table-styled">
            <thead>
              <tr>
                <th>优先级</th><th>名称</th><th>子类型</th><th>条件类型</th>
                <th>条件配置</th><th>严重度</th><th>启用</th><th>更新</th><th>操作</th>
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
                  <td>{SUBTYPE_LABELS[r.subtype] ?? r.subtype}</td>
                  <td>{COND_TYPE_LABELS[r.conditionType] ?? r.conditionType}</td>
                  <td className="font-mono text-xs">{prettyCond(r.conditionConfig)}</td>
                  <td>
                    {editingId === r.id ? (
                      <select
                        value={draft.severity}
                        onChange={(e) => setDraft({ ...draft, severity: e.target.value })}
                        className="input-field !w-auto !py-1"
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    ) : (
                      <span className={`tag ${r.severity === "high" ? "tag-red" : r.severity === "medium" ? "tag-orange" : "tag-green"}`}>
                        {r.severity}
                      </span>
                    )}
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
                        <ShieldAlert className="h-4 w-4 text-[var(--color-text-muted)]" />
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
