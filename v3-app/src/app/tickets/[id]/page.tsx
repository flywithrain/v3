"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  CheckCircle,
  XCircle,
  RotateCw,
  Package,
  Coins,
  ShieldCheck,
  AlertTriangle,
  ArrowLeftRight,
  Sparkles,
  Brain,
} from "lucide-react";
import { apiFetch, ApiError, useSession } from "@/components/shared/auth-context";
import { useToast } from "@/components/shared/toast";
import { formatDateTime } from "@/lib/utils";
import { StatusBadge, SeverityBadge, subtypeLabel, sourceLabel } from "@/components/shared/badges";

interface TimelineItem {
  id: string;
  approverId: string | null;
  approverName: string;
  level: number | null;
  action: string;
  comment: string | null;
  fromStatus: string;
  toStatus: string;
  createdAt: string;
}
interface TicketDetail {
  id: string;
  ticketNo: string;
  source: string;
  category: string;
  subtype: string;
  severity: string;
  estimatedAmount: string;
  description: string;
  status: string;
  currentLevel: number | null;
  reporterId: string | null;
  reporterName: string | null;
  v2ShipmentId: string | null;
  waybillSnapshotId: string | null;
  resubmitCount: number;
  version: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}
interface Movement {
  id: string;
  ticketId: string | null;
  approvalRecordId: string | null;
  skuCode: string;
  batchNo: string;
  movementType: string;
  quantity: number;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  reason: string | null;
  createdAt: string;
}
interface Compensation {
  id: string;
  ticketId: string;
  approvalRecordId: string;
  direction: string;
  amount: string;
  counterpartyName: string | null;
  reason: string | null;
  status: string;
  createdAt: string;
}
interface AuditItem {
  id: string;
  actorId: string | null;
  targetType: string;
  targetId: string;
  action: string;
  detail: unknown;
  createdAt: string;
}
interface DetailResp {
  ticket: TicketDetail;
  snapshot: {
    id: string;
    externalCode: string | null;
    storeName: string | null;
    receiverName: string | null;
    receiverPhoneMasked: string | null;
    receiverAddressSummary: string | null;
    batchId: string | null;
    skuCount: number;
    totalQuantity: string;
    sourceSyncedAt: string | null;
  } | null;
  snapshotSyncedAt: string | null;
  isLiveFromV2: boolean;
  skuItems: { id: string; skuCode: string; skuName: string; skuQuantity: string; skuSpec: string | null }[];
  approvalTimeline: TimelineItem[];
  movements: Movement[];
  compensations: Compensation[];
  audits: AuditItem[];
  canApprove: { level1: boolean; level2: boolean };
}

const EXEC_ACTIONS = [
  { value: "pay_customer", label: "赔付客户" },
  { value: "reship", label: "补发" },
  { value: "pay_customer_and_reship", label: "赔付并补发" },
  { value: "return_in", label: "退货入库" },
  { value: "address_correct_reship", label: "更正地址补发" },
];

const ACTION_LABELS: Record<string, string> = {
  approve: "通过",
  reject: "拒绝",
  resubmit: "重提",
};

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { user, loading: sessLoading } = useSession();

  const [data, setData] = useState<DetailResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [modal, setModal] = useState<null | "approve" | "reject" | "resubmit" | "transfer">(null);
  const [comment, setComment] = useState("");
  const [executionAction, setExecutionAction] = useState("pay_customer");
  const [actionLevel, setActionLevel] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // 转交相关
  const [transferCandidates, setTransferCandidates] = useState<{ id: string; name: string }[]>([]);
  const [transferTargetId, setTransferTargetId] = useState("");
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  // AI 建议相关
  interface AiSuggestResult {
    suggestedSubtype: string;
    subtypeConfidence: number;
    suggestedSeverity: string;
    severityConfidence: number;
    approvalSuggestion: string;
    suggestQuickApprove: boolean;
    matchedKeywords: string[];
    disclaimer: string;
    aiSource?: { model: string; provider: string };
  }
  const [aiSuggest, setAiSuggest] = useState<AiSuggestResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  async function fetchAiSuggest() {
    setAiLoading(true);
    setAiError(null);
    try {
      const r = await apiFetch<AiSuggestResult>(`/api/tickets/${id}/ai-suggest`);
      setAiSuggest(r);
    } catch (e) {
      setAiError((e as Error).message);
      setAiSuggest(null);
    } finally {
      setAiLoading(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await apiFetch<DetailResp>(`/api/tickets/${id}`);
      setData(r);
      setActionLevel(r.ticket.currentLevel === 2 ? 2 : 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function refreshV2() {
    setRefreshing(true);
    try {
      await apiFetch(`/api/tickets/${id}/refresh-v2`, { method: "POST" });
      toast.showToast("已从 V2 刷新运单数据", "success");
      await load();
    } catch (e) {
      toast.showToast((e as Error).message, "error");
    } finally {
      setRefreshing(false);
    }
  }

  async function openTransferModal() {
    setLoadingCandidates(true);
    try {
      const r = await apiFetch<{ candidates: { id: string; name: string }[] }>(`/api/tickets/${id}/transfer`);
      setTransferCandidates(r.candidates);
      setTransferTargetId(r.candidates[0]?.id ?? "");
      setModal("transfer");
    } catch (e) {
      toast.showToast("获取审批人列表失败：" + (e as Error).message, "error");
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function submitTransfer() {
    if (!transferTargetId) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ newApproverName: string }>(
        `/api/tickets/${id}/transfer`,
        { method: "POST", body: JSON.stringify({ targetApproverId: transferTargetId, comment: comment.trim() || undefined }) }
      );
      toast.showToast(`已转交给审批人 ${r.newApproverName}`, "success");
      setModal(null);
      setComment("");
      await load();
    } catch (e) {
      toast.showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function submitAction() {
    if (!data) return;
    setBusy(true);
    const idempotencyKey = `act_${data.ticket.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const endpoint =
      modal === "approve" ? "approve" : modal === "reject" ? "reject" : "resubmit";
    const payload: Record<string, unknown> = {
      comment: comment.trim(),
      expectedVersion: data.ticket.version,
    };
    if (modal === "approve") {
      payload.executionAction = executionAction;
      payload.level = actionLevel;
    } else if (modal === "reject") {
      payload.level = actionLevel;
    }
    try {
      const r = await apiFetch<{ toStatus: string; approvalRecordId?: string }>(
        `/api/tickets/${id}/${endpoint}`,
        { method: "POST", body: JSON.stringify(payload), idempotencyKey }
      );
      toast.showToast(`操作成功：流转至 ${r.toStatus}`, "success");
      setModal(null);
      setComment("");
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === "TICKET_VERSION_CONFLICT") {
        toast.showToast("该工单已被其他人处理，请刷新后查看", "error");
        await load();
      } else {
        toast.showToast((e as Error).message, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  if (sessLoading || loading) return <div className="p-6 text-[var(--color-text-muted)]">加载中…</div>;
  if (err) return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="alert alert-danger">加载失败：{err}</div>
      <Link href="/tickets" className="btn-ghost mt-3 no-underline">返回列表</Link>
    </div>
  );
  if (!data) return null;

  const t = data.ticket;
  const canApproveL1 = data.canApprove.level1;
  const canApproveL2 = data.canApprove.level2;
  const canResubmit = (t.status === "rejected" || t.status === "auto_rejected_timeout") && t.resubmitCount < 2;
  const isAdmin = user?.roleCodes.includes("admin");
  const canTransfer = isAdmin && (t.status === "level1_reviewing" || t.status === "level2_reviewing");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <Link href="/tickets" className="btn-ghost mb-2 no-underline">
        <ArrowLeft className="h-4 w-4" /> 返回列表
      </Link>

      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-[var(--color-text-main)]">{t.ticketNo}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={t.status} />
              <SeverityBadge severity={t.severity} />
              <span className="tag tag-gray">{subtypeLabel(t.subtype)}</span>
              <span className="tag tag-gray">{sourceLabel(t.source)}</span>
              <span className="text-xs text-[var(--color-text-muted)]">
                当前层级 {t.currentLevel ?? "-"} · 重提次数 {t.resubmitCount}/2 · version {t.version}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={refreshV2} disabled={refreshing} className="btn-ghost">
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> 刷新 V2
            </button>
            {canTransfer && (
              <button onClick={openTransferModal} disabled={loadingCandidates} className="btn-outline">
                <ArrowLeftRight className="h-4 w-4" /> 转交审批人
              </button>
            )}
            {canApproveL1 && (
              <button onClick={() => { setModal("approve"); setActionLevel(1); }} className="btn-primary">
                <CheckCircle className="h-4 w-4" /> 一级通过
              </button>
            )}
            {canApproveL2 && (
              <button onClick={() => { setModal("approve"); setActionLevel(2); }} className="btn-primary">
                <CheckCircle className="h-4 w-4" /> 二级通过
              </button>
            )}
            {(canApproveL1 || canApproveL2) && (
              <button
                onClick={() => setModal("reject")}
                className="btn-danger"
              >
                <XCircle className="h-4 w-4" /> 拒绝
              </button>
            )}
            {canResubmit && (
              <button onClick={() => setModal("resubmit")} className="btn-outline">
                <RotateCw className="h-4 w-4" /> 重提
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <KV label="预估赔付金额" value={`¥ ${t.estimatedAmount}`} />
          <KV label="截止时间" value={formatDateTime(t.dueAt)} />
          <KV label="上报人" value={t.reporterName ?? "-"} />
          <KV label="创建时间" value={formatDateTime(t.createdAt)} />
          <KV label="更新时间" value={formatDateTime(t.updatedAt)} />
          <KV label="运单 ID" value={<code className="text-xs">{t.v2ShipmentId ?? "-"}</code>} />
        </div>
        <div className="mt-3">
          <div className="text-xs text-[var(--color-text-muted)]">问题描述</div>
          <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-main)]">{t.description}</div>
        </div>
      </div>

      {/* AI 辅助建议卡片 */}
      <div className="card mt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--color-text-main)]">
            <Brain className="h-4 w-4 text-purple-500" /> AI 辅助建议
            {aiSuggest && (
              <>
                <span className="tag tag-orange text-xs">AI建议,需人工确认</span>
                {aiSuggest.aiSource && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    ({aiSuggest.aiSource.model})
                  </span>
                )}
              </>
            )}
          </h2>
          {!aiSuggest && !aiLoading && (
            <button onClick={fetchAiSuggest} className="btn-ghost text-sm">
              <Sparkles className="h-4 w-4" /> 获取 AI 建议
            </button>
          )}
        </div>
        {aiLoading && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Sparkles className="h-4 w-4 animate-pulse" /> AI 分析中…
          </div>
        )}
        {aiError && (
          <div className="text-sm text-red-500">AI 建议获取失败：{aiError}</div>
        )}
        {aiSuggest && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs text-[var(--color-text-muted)]">推荐异常类型</div>
              <div className="mt-1 flex items-center gap-2">
                <span className="tag tag-teal">{subtypeLabel(aiSuggest.suggestedSubtype)}</span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  置信度 {(aiSuggest.subtypeConfidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            <div>
              <div className="text-xs text-[var(--color-text-muted)]">推荐严重度</div>
              <div className="mt-1 flex items-center gap-2">
                <SeverityBadge severity={aiSuggest.suggestedSeverity} />
                <span className="text-xs text-[var(--color-text-muted)]">
                  置信度 {(aiSuggest.severityConfidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-xs text-[var(--color-text-muted)]">审批建议</div>
              <div className="mt-1 text-sm text-[var(--color-text-main)]">{aiSuggest.approvalSuggestion}</div>
            </div>
            {aiSuggest.matchedKeywords.length > 0 && (
              <div className="sm:col-span-2">
                <div className="text-xs text-[var(--color-text-muted)]">匹配关键词</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {aiSuggest.matchedKeywords.map((kw) => (
                    <span key={kw} className="tag tag-gray text-xs">{kw}</span>
                  ))}
                </div>
              </div>
            )}
            {aiSuggest.suggestQuickApprove && (
              <div className="sm:col-span-2">
                <div className="flex items-center gap-2 rounded bg-green-50 px-3 py-2 text-sm text-green-700">
                  <CheckCircle className="h-4 w-4" /> AI 分析：小额工单，建议快速处理
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-text-main)]">运单快照</h2>
          {data.isLiveFromV2 ? (
            <span className="tag tag-green">实时获取自 V2</span>
          ) : (
            <span className="tag tag-gray">本地缓存，同步于 {formatDateTime(data.snapshotSyncedAt)}</span>
          )}
        </div>
        {data.snapshot ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <KV label="外部编码" value={data.snapshot.externalCode ?? "-"} />
              <KV label="店铺" value={data.snapshot.storeName ?? "-"} />
              <KV label="收货人" value={data.snapshot.receiverName ?? "-"} />
              <KV label="收货电话（脱敏）" value={data.snapshot.receiverPhoneMasked ?? "-"} />
              <KV label="收货地址" value={data.snapshot.receiverAddressSummary ?? "-"} />
              <KV label="批次" value={data.snapshot.batchId ?? "-"} />
              <KV label="SKU 数" value={String(data.snapshot.skuCount)} />
              <KV label="总数" value={data.snapshot.totalQuantity} />
            </div>
            {data.skuItems.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-sm font-semibold">SKU 明细</h3>
                <div className="table-wrapper">
                  <table className="table-styled">
                    <thead><tr><th>SKU</th><th>名称</th><th>数量</th><th>规格</th></tr></thead>
                    <tbody>
                      {data.skuItems.map((s) => (
                        <tr key={s.id}>
                          <td className="font-mono text-xs">{s.skuCode}</td>
                          <td>{s.skuName}</td>
                          <td>{s.skuQuantity}</td>
                          <td>{s.skuSpec ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-[var(--color-text-muted)]">未关联运单快照</div>
        )}
      </div>

      <div className="card mt-4">
        <h2 className="mb-3 text-base font-semibold text-[var(--color-text-main)]">审批历史</h2>
        {data.approvalTimeline.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">暂无审批记录</div>
        ) : (
          <div className="timeline">
            {data.approvalTimeline.map((a) => (
              <div key={a.id} className={`timeline-item ${a.action === "reject" ? "reject" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tag tag-gray">{ACTION_LABELS[a.action] ?? a.action}</span>
                  {a.level != null && <span className="tag tag-teal">{a.level} 级</span>}
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {a.fromStatus} → {a.toStatus}
                  </span>
                </div>
                <div className="mt-1 text-sm">
                  <b>{a.approverName}</b> · {formatDateTime(a.createdAt)}
                </div>
                {a.comment && <div className="mt-1 text-sm text-[var(--color-text-secondary)]">备注：{a.comment}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--color-text-main)]">
            <Coins className="h-4 w-4 text-[var(--color-primary)]" /> 赔付记录
          </h2>
          {data.compensations.length === 0 ? (
            <div className="text-sm text-[var(--color-text-muted)]">暂无</div>
          ) : (
            <div className="table-wrapper">
              <table className="table-styled">
                <thead><tr><th>方向</th><th>金额</th><th>对方</th><th>状态</th><th>时间</th></tr></thead>
                <tbody>
                  {data.compensations.map((c) => (
                    <tr key={c.id}>
                      <td>{c.direction === "pay_customer" ? "赔付客户" : c.direction}</td>
                      <td>¥ {c.amount}</td>
                      <td>{c.counterpartyName ?? "-"}</td>
                      <td>{c.status}</td>
                      <td className="text-xs">{formatDateTime(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--color-text-main)]">
            <Package className="h-4 w-4 text-[var(--color-primary)]" /> 库存流水
          </h2>
          {data.movements.length === 0 ? (
            <div className="text-sm text-[var(--color-text-muted)]">暂无</div>
          ) : (
            <div className="table-wrapper">
              <table className="table-styled">
                <thead><tr><th>SKU</th><th>批次</th><th>类型</th><th>数量</th><th>时间</th></tr></thead>
                <tbody>
                  {data.movements.map((m) => (
                    <tr key={m.id}>
                      <td className="font-mono text-xs">{m.skuCode}</td>
                      <td className="text-xs">{m.batchNo}</td>
                      <td>{m.movementType === "outbound" ? "出库" : m.movementType === "return_in" ? "退货入库" : m.movementType}</td>
                      <td>{m.movementType === "outbound" ? "-" : "+"}{m.quantity}</td>
                      <td className="text-xs">{formatDateTime(m.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card mt-4">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--color-text-main)]">
          <ShieldCheck className="h-4 w-4 text-[var(--color-primary)]" /> 审计日志
        </h2>
        {data.audits.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">暂无</div>
        ) : (
          <div className="table-wrapper">
            <table className="table-styled">
              <thead><tr><th>动作</th><th>对象</th><th>详情</th><th>时间</th></tr></thead>
              <tbody>
                {data.audits.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono text-xs">{a.action}</td>
                    <td>{a.targetType}:{a.targetId.slice(0, 8)}</td>
                    <td className="text-xs">{tryJson(a.detail)}</td>
                    <td className="text-xs">{formatDateTime(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && modal === "transfer" && (
        <Modal title="转交审批人" onClose={() => setModal(null)}>
          <label className="mb-3 flex flex-col gap-1">
            <span className="text-sm text-[var(--color-text-secondary)]">目标审批人</span>
            <select
              value={transferTargetId}
              onChange={(e) => setTransferTargetId(e.target.value)}
              className="input-field"
            >
              {transferCandidates.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-[var(--color-text-secondary)]">转交原因</span>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} className="input-field" placeholder="输入转交原因（选填）" />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setModal(null)} className="btn-ghost">取消</button>
            <button
              onClick={submitTransfer}
              disabled={busy || !transferTargetId}
              className="btn-primary"
            >
              {busy ? "转交中…" : "确认转交"}
            </button>
          </div>
        </Modal>
      )}

      {modal && modal !== "transfer" && (
        <Modal title={modal === "approve" ? "审批通过" : modal === "reject" ? "审批拒绝" : "重提工单"} onClose={() => setModal(null)}>
          {(modal === "approve" || modal === "reject") && (canApproveL1 && canApproveL2) && (
            <label className="mb-3 flex flex-col gap-1">
              <span className="text-sm text-[var(--color-text-secondary)]">审批层级</span>
              <select value={actionLevel} onChange={(e) => setActionLevel(Number(e.target.value) as 1 | 2)} className="input-field">
                <option value={1}>一级</option>
                <option value={2}>二级</option>
              </select>
            </label>
          )}
          {modal === "approve" && (
            <label className="mb-3 flex flex-col gap-1">
              <span className="text-sm text-[var(--color-text-secondary)]">执行动作</span>
              <select value={executionAction} onChange={(e) => setExecutionAction(e.target.value)} className="input-field">
                {EXEC_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-sm text-[var(--color-text-secondary)]">{modal === "resubmit" ? "重提说明" : "审批意见"}</span>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} className="input-field" />
          </label>
          {modal === "resubmit" && (
            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <AlertTriangle className="h-4 w-4" /> 重提将根据当前金额/严重度重新路由审批层级。已重提 {t.resubmitCount}/2 次。
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setModal(null)} className="btn-ghost">取消</button>
            <button
              onClick={submitAction}
              disabled={busy}
              className={modal === "reject" ? "btn-danger" : "btn-primary"}
            >
              {busy ? "提交中…" : "确认"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      <span className="text-sm text-[var(--color-text-main)]">{value}</span>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-base font-semibold text-[var(--color-text-main)]">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function tryJson(d: unknown): string {
  if (!d) return "-";
  if (typeof d === "string") return d;
  try { return JSON.stringify(d); } catch { return String(d); }
}
