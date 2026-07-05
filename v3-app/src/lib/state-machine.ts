import type { ApprovalAction, TicketStatus, ExecutionAction } from "@/types";

// 物流工单合法流转（§7.1）
const LOGISTICS_TRANSITIONS: Record<string, TicketStatus[]> = {
  draft: ["pending_review"],
  pending_review: ["level1_reviewing"],
  // 累计拒绝达上限时直接进入 closed_rejected_limit（§6.3）
  level1_reviewing: ["executing", "level2_reviewing", "rejected", "closed_rejected_limit"],
  level2_reviewing: ["executing", "rejected", "auto_rejected_timeout", "closed_rejected_limit"],
  rejected: ["pending_review", "closed_rejected_limit"],
  executing: ["completed"],
  completed: [],
  closed: [],
  auto_rejected_timeout: ["pending_review", "closed"],
  closed_rejected_limit: ["pending_review", "closed"],
};

// 品控工单（后续轮次补完整，此处先占位基础流转）
const QC_TRANSITIONS: Record<string, TicketStatus[]> = {
  ...LOGISTICS_TRANSITIONS,
  level2_reviewing: [...LOGISTICS_TRANSITIONS.level2_reviewing, "completed"], // 允许 quick_release 直达
};

export function canTransition(from: TicketStatus, to: TicketStatus, category: "logistics" | "quality_control" = "logistics"): boolean {
  const table = category === "quality_control" ? QC_TRANSITIONS : LOGISTICS_TRANSITIONS;
  const allowed = table[from] ?? [];
  return allowed.includes(to);
}

/** 一级审批通过后，若金额未超阈值且非 high，流向 executing；否则升二级 */
export function nextStatusOnLevel1Approve(opts: { exceedsThreshold: boolean; isHigh: boolean }): TicketStatus {
  if (opts.exceedsThreshold || opts.isHigh) return "level2_reviewing";
  return "executing";
}

export function nextStatusOnLevel2Approve(): TicketStatus {
  return "executing";
}

export function nextStatusOnReject(): TicketStatus {
  return "rejected";
}

export function nextStatusOnResubmitExhausted(): TicketStatus {
  return "closed_rejected_limit";
}

export function nextStatusOnLevel2Timeout(): TicketStatus {
  return "auto_rejected_timeout";
}

// 是否已处于终态/关闭类
const TERMINAL_STATUSES: TicketStatus[] = ["completed", "closed", "auto_rejected_timeout", "closed_rejected_limit"];

export function isTerminal(status: TicketStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 校验某动作是否被允许（action 可 emit 状态到 to-status） */
export function assertCanApproveAtLevel(status: TicketStatus, level: 1 | 2): { ok: boolean; reason?: string } {
  if (status === "level1_reviewing" && level === 1) return { ok: true };
  if (status === "level2_reviewing" && level === 2) return { ok: true };
  return { ok: false, reason: `当前状态 ${status} 不适用 ${level} 级审批` };
}

// 物流执行动作需要扣库存的类型
export function actionNeedsOutbound(action: ExecutionAction): boolean {
  return action === "reship" || action === "pay_customer_and_reship" || action === "address_correct_reship";
}

export function actionNeedsReturnIn(action: ExecutionAction): boolean {
  return action === "return_in" || action === "pay_customer_and_reship";
}

export function actionNeedsPayCustomer(action: ExecutionAction): boolean {
  return action === "pay_customer" || action === "pay_customer_and_reship";
}

// 品控执行动作的赔付方向
export function qcActionNeedsRecoverSupplier(action: ExecutionAction): boolean {
  return action === "return_supplier_recover" || action === "repurchase_recover" || action === "downgrade_recover";
}

export function qcActionNeedsUnlock(action: ExecutionAction): boolean {
  return action === "release_goods" || action === "quick_release";
}

export function qcActionNeedsReturnSupplier(action: ExecutionAction): boolean {
  return action === "return_supplier_recover";
}

export function qcActionNeedsScrap(action: ExecutionAction): boolean {
  return action === "repurchase_recover";
}

// 扫描批次状态合法流转（§7.2）
const SCAN_BATCH_TRANSITIONS: Record<string, string[]> = {
  scan_recorded: ["qc_passed", "qc_hold"],
  qc_passed: ["closed"],
  qc_hold: ["escalated", "released", "returned_supplier", "repurchase_pending", "downgraded", "closed"],
  escalated: ["released", "returned_supplier", "repurchase_pending", "downgraded", "closed"],
  released: ["closed"],
  returned_supplier: ["closed"],
  repurchase_pending: ["closed"],
  downgraded: ["closed"],
  closed: [],
};

export function canTransitionBatch(from: string, to: string): boolean {
  const allowed = SCAN_BATCH_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

// 占位：审批动作 → 状态记录用语
export function actionLabel(action: ApprovalAction): string {
  const map: Record<ApprovalAction, string> = {
    approve: "审批通过",
    reject: "审批拒绝",
    auto_escalate: "自动升级",
    auto_reject: "自动驳回",
    transfer: "转交",
    quick_release: "快速放行",
  };
  return map[action] ?? action;
}
