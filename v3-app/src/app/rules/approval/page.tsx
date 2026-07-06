"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import { apiFetch, useSession } from "@/components/shared/auth-context";
import { useToast } from "@/components/shared/toast";
import { formatDateTime } from "@/lib/utils";

/* ── 类型 ── */

interface ApprovalRule {
  id: string;
  name: string;
  category: string;
  conditionConfig: ConditionConfig;
  targetLevel: number;
  timeoutHours: number | null;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

interface ConditionConfig {
  amountLte?: number; // 金额 ≤
  amountGt?: number;  // 金额 >
  severity?: string;  // 逗号分隔: low,medium,high
  level?: number;
}

interface RuleDraft {
  name: string;
  category: string;
  targetLevel: number;
  timeoutHours: string;
  enabled: boolean;
  priority: string;
  condition: ConditionConfig;
}

const emptyDraft: RuleDraft = {
  name: "",
  category: "logistics",
  targetLevel: 1,
  timeoutHours: "8",
  enabled: true,
  priority: "100",
  condition: {},
};

const SEVERITY_OPTIONS = [
  { value: "low", label: "低 (low)", color: "bg-blue-100 text-blue-800" },
  { value: "medium", label: "中 (medium)", color: "bg-yellow-100 text-yellow-800" },
  { value: "high", label: "高 (high)", color: "bg-red-100 text-red-800" },
];

const CATEGORY_LABELS: Record<string, string> = {
  logistics: "物流异常",
  quality_control: "品控异常",
  all: "全部类别",
};

/* ── 条件 → 可读描述 ── */

function describeCondition(c: ConditionConfig | null | undefined): string {
  if (!c || typeof c !== "object") return "无条件（始终命中）";
  const parts: string[] = [];
  if (c.amountLte !== undefined && c.amountLte !== null) parts.push(`金额 ≤ ¥${c.amountLte}`);
  if (c.amountGt !== undefined && c.amountGt !== null) parts.push(`金额 > ¥${c.amountGt}`);
  if (c.severity) {
    const map: Record<string, string> = { low: "低", medium: "中", high: "高" };
    const labels = c.severity
      .split(",")
      .map((s) => map[s.trim()] ?? s.trim())
      .filter(Boolean);
    if (labels.length > 0) parts.push(`严重度: ${labels.join("、")}`);
  }
  if (c.level !== undefined && c.level !== null) parts.push(`审批层级 = ${c.level} 级`);
  return parts.length > 0 ? parts.join("，") : "无条件（始终命中）";
}

/* ── 页面组件 ── */

export default function ApprovalRulesPage() {
  const { user, loading } = useSession();
  const toast = useToast();
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [loading2, setLoading2] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ApprovalRule | null>(null);
  const [draft, setDraft] = useState<RuleDraft>({ ...emptyDraft });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  /* ── 打开编辑弹窗 ── */
  function openEdit(r: ApprovalRule) {
    const cfg = (r.conditionConfig ?? {}) as ConditionConfig;
    setEditingRule(r);
    setDraft({
      name: r.name,
      category: r.category,
      targetLevel: r.targetLevel,
      timeoutHours: r.timeoutHours == null ? "" : String(r.timeoutHours),
      enabled: r.enabled,
      priority: String(r.priority),
      condition: { ...cfg },
    });
    setDialogOpen(true);
  }

  /* ── 打开新增弹窗 ── */
  function openNew() {
    setEditingRule(null);
    setDraft({ ...emptyDraft });
    setDialogOpen(true);
  }

  /* ── 条件编辑辅助 ── */
  function setAmountLte(v: string) {
    const num = v === "" ? undefined : Number(v);
    setDraft({
      ...draft,
      condition: num === undefined
        ? { ...draft.condition, amountLte: undefined }
        : { ...draft.condition, amountLte: isNaN(num) ? undefined : num },
    });
  }

  function setAmountGt(v: string) {
    const num = v === "" ? undefined : Number(v);
    setDraft({
      ...draft,
      condition: num === undefined
        ? { ...draft.condition, amountGt: undefined }
        : { ...draft.condition, amountGt: isNaN(num) ? undefined : num },
    });
  }

  function toggleSeverity(sev: string) {
    const current = draft.condition.severity
      ? draft.condition.severity.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const next = current.includes(sev)
      ? current.filter((s) => s !== sev)
      : [...current, sev];
    setDraft({
      ...draft,
      condition: {
        ...draft.condition,
        severity: next.length > 0 ? next.join(",") : undefined,
      },
    });
  }

  function getSeverityList(): string[] {
    if (!draft.condition.severity) return [];
    return draft.condition.severity.split(",").map((s) => s.trim()).filter(Boolean);
  }

  /* ── 保存 ── */
  async function handleSave() {
    if (!draft.name.trim()) {
      toast.showToast("请输入规则名称", "error");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        category: draft.category,
        conditionConfig: draft.condition,
        targetLevel: Number(draft.targetLevel),
        timeoutHours: draft.timeoutHours === "" ? null : Number(draft.timeoutHours),
        enabled: draft.enabled,
        priority: Number(draft.priority),
      };
      if (editingRule) {
        body.id = editingRule.id;
      }
      await apiFetch("/api/rules/approval", {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast.showToast(editingRule ? "规则已更新" : "规则已创建", "success");
      setDialogOpen(false);
      setEditingRule(null);
      await load();
    } catch (e) {
      toast.showToast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  /* ── 删除 ── */
  async function handleDelete(r: ApprovalRule) {
    if (!confirm(`确定要删除规则「${r.name}」吗？此操作不可撤销。`)) return;
    setDeletingId(r.id);
    try {
      await apiFetch(`/api/rules/approval/${r.id}`, { method: "DELETE" });
      toast.showToast("规则已删除", "success");
      await load();
    } catch (e) {
      toast.showToast((e as Error).message, "error");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* 页头 */}
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--color-text-main)]">审批规则</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            按金额阈值 / 严重度路由审批层级 · 按优先级从高到低匹配，命中即停
            {!isAdmin && " · 仅管理员可修改"}
          </p>
        </div>
        {isAdmin && (
          <button onClick={openNew} className="btn-primary flex items-center gap-1.5">
            <Plus className="h-4 w-4" />
            新增规则
          </button>
        )}
      </header>

      {loading2 && rules.length === 0 && (
        <div className="text-sm text-[var(--color-text-muted)]">加载中…</div>
      )}

      {/* 规则列表 */}
      <div className="space-y-3">
        {rules.map((r) => (
          <div
            key={r.id}
            className="card !p-4 flex items-start gap-4 hover:border-[var(--color-accent)]/30 transition-colors"
          >
            {/* 优先级徽章 */}
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-[var(--color-bg-subtle)] flex items-center justify-center text-sm font-bold text-[var(--color-text-main)]">
              {r.priority}
            </div>

            {/* 规则信息 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[var(--color-text-main)]">{r.name}</span>
                <span className="tag tag-teal">{CATEGORY_LABELS[r.category] ?? r.category}</span>
                <span className={`tag ${r.targetLevel === 2 ? "tag-purple" : "tag-teal"}`}>
                  {r.targetLevel} 级审批
                </span>
                {r.timeoutHours && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {r.timeoutHours}h 超时
                  </span>
                )}
                {r.enabled ? (
                  <span className="tag tag-green">启用</span>
                ) : (
                  <span className="tag tag-gray">停用</span>
                )}
              </div>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                📋 {describeCondition(r.conditionConfig)}
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                更新于 {formatDateTime(r.updatedAt)}
              </p>
            </div>

            {/* 操作按钮 */}
            {isAdmin && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => openEdit(r)}
                  className="btn-ghost !py-1.5 !px-2.5"
                  title="编辑"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleDelete(r)}
                  disabled={deletingId === r.id}
                  className="btn-ghost !py-1.5 !px-2.5 text-red-500 hover:text-red-700"
                  title="删除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        ))}

        {!loading2 && rules.length === 0 && (
          <div className="card !p-8 text-center text-[var(--color-text-muted)]">
            暂无审批规则，{isAdmin ? "请点击「新增规则」创建" : "请联系管理员添加"}
          </div>
        )}
      </div>

      {/* ── 编辑/新增弹窗 ── */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
          {/* 遮罩 */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => { setDialogOpen(false); setEditingRule(null); }}
          />

          {/* 弹窗 */}
          <div className="relative w-full max-w-lg mx-4 bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-xl shadow-2xl max-h-[85vh] overflow-y-auto">
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
              <h2 className="text-lg font-bold text-[var(--color-text-main)]">
                {editingRule ? "编辑规则" : "新增规则"}
              </h2>
              <button
                onClick={() => { setDialogOpen(false); setEditingRule(null); }}
                className="btn-ghost !p-1"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 表单 */}
            <div className="px-5 py-4 space-y-4">
              {/* 名称 */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1">
                  规则名称 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="例如：物流高金额进二级"
                  className="input-field w-full"
                />
              </div>

              {/* 类别 */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1">
                  适用类别 <span className="text-red-500">*</span>
                </label>
                <select
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  className="input-field w-full"
                >
                  <option value="logistics">物流异常</option>
                  <option value="quality_control">品控异常</option>
                  <option value="all">全部类别（兜底）</option>
                </select>
              </div>

              {/* ── 条件编辑器 ── */}
              <fieldset className="border border-[var(--color-border)] rounded-lg p-4">
                <legend className="text-sm font-semibold text-[var(--color-text-main)] px-1">
                  匹配条件（AND 关系，全部满足才命中）
                </legend>

                {/* 金额阈值 */}
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div>
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                      金额 ≤（小于等于）
                    </label>
                    <div className="relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)]">¥</span>
                      <input
                        type="number"
                        value={draft.condition.amountLte ?? ""}
                        onChange={(e) => setAmountLte(e.target.value)}
                        placeholder="不限制"
                        className="input-field w-full pl-7"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                      金额 &gt;（大于）
                    </label>
                    <div className="relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)]">¥</span>
                      <input
                        type="number"
                        value={draft.condition.amountGt ?? ""}
                        onChange={(e) => setAmountGt(e.target.value)}
                        placeholder="不限制"
                        className="input-field w-full pl-7"
                      />
                    </div>
                  </div>
                </div>
                {(draft.condition.amountLte !== undefined || draft.condition.amountGt !== undefined) && (
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    当前区间：
                    {draft.condition.amountGt !== undefined && draft.condition.amountLte !== undefined
                      ? `¥${draft.condition.amountGt} &lt; 金额 ≤ ¥${draft.condition.amountLte}`
                      : draft.condition.amountLte !== undefined
                        ? `金额 ≤ ¥${draft.condition.amountLte}`
                        : `金额 > ¥${draft.condition.amountGt}`}
                  </p>
                )}

                {/* 严重度 */}
                <div className="mt-4">
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">
                    严重度（可多选，留空表示不限制）
                  </label>
                  <div className="flex gap-2">
                    {SEVERITY_OPTIONS.map((opt) => {
                      const active = getSeverityList().includes(opt.value);
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => toggleSeverity(opt.value)}
                          className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                            active
                              ? `${opt.color} border-current font-medium`
                              : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-secondary)]"
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 审批层级（仅 all 类别有意义） */}
                {draft.category === "all" && (
                  <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                      当前审批层级 =（用于超时配置，如"当前已是2级审批时设置超时"）
                    </label>
                    <input
                      type="number"
                      value={draft.condition.level ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft({
                          ...draft,
                          condition: v === ""
                            ? { ...draft.condition, level: undefined }
                            : { ...draft.condition, level: isNaN(Number(v)) ? undefined : Number(v) },
                        });
                      }}
                      placeholder="不限制"
                      className="input-field w-24"
                    />
                  </div>
                )}
              </fieldset>

              {/* 目标审批层级 */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1">
                  目标审批层级 <span className="text-red-500">*</span>
                </label>
                <select
                  value={draft.targetLevel}
                  onChange={(e) => setDraft({ ...draft, targetLevel: Number(e.target.value) })}
                  className="input-field w-full"
                >
                  <option value={1}>一级审批</option>
                  <option value={2}>二级审批</option>
                </select>
              </div>

              {/* 超时 & 优先级 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1">
                    超时（小时）
                  </label>
                  <input
                    type="number"
                    value={draft.timeoutHours}
                    onChange={(e) => setDraft({ ...draft, timeoutHours: e.target.value })}
                    placeholder="留空不设超时"
                    className="input-field w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1">
                    优先级
                  </label>
                  <input
                    type="number"
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                    className="input-field w-full"
                  />
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">越小越优先</p>
                </div>
              </div>

              {/* 启用 */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm text-[var(--color-text-main)]">启用规则</span>
              </label>

              {/* 条件预览 */}
              <div className="bg-[var(--color-bg-subtle)] rounded-lg p-3 border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-muted)] mb-1">规则效果预览：</p>
                <p className="text-sm text-[var(--color-text-main)]">
                  当 <strong>{CATEGORY_LABELS[draft.category]}</strong> 工单
                  {describeCondition(draft.condition) !== "无条件（始终命中）" && (
                    <>满足「{describeCondition(draft.condition)}」</>
                  )}
                  时 → 路由至 <strong>{draft.targetLevel} 级审批</strong>
                  {draft.timeoutHours && <>，{draft.timeoutHours}h 超时</>}
                </p>
              </div>
            </div>

            {/* 按钮 */}
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)]">
              <button
                onClick={() => { setDialogOpen(false); setEditingRule(null); }}
                className="btn-ghost"
              >
                取消
              </button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">
                {saving ? "保存中…" : editingRule ? "保存修改" : "创建规则"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
