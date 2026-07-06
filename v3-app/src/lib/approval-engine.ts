import { db } from "@/lib/db";
import { approvalRules } from "@/lib/db-schema";
import { asc, and, eq } from "drizzle-orm";
import type { Severity, SimpleUser, TicketStatus } from "@/types";

/**
 * 审批规则路由：根据金额、严重度、类别，按规则优先级确定目标审批层级与超时时长。
 * §6.1 默认阈值：金额 > 100 或 high → 二级；其余物流 → 一级；品控默认二级。
 */

export interface ApprovalRouteResult {
  targetLevel: 1 | 2;
  dueAt: Date | null;
  matchedRuleId: string | null;
  reason: string;
}

interface ConditionConfig {
  amountLte?: number;
  amountGt?: number;
  severity?: string; // 逗号分隔
  level?: number;
}

export async function routeApproval(opts: {
  category: "logistics" | "quality_control";
  subtype: string;
  severity: Severity;
  estimatedAmount: number;
}): Promise<ApprovalRouteResult> {
  const rules = await db
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.enabled, true), eq(approvalRules.category, opts.category)))
    .orderBy(asc(approvalRules.priority));

  for (const rule of rules) {
    const cfg = rule.conditionConfig as ConditionConfig;
    if (matches(cfg, opts)) {
      const targetLevel = (rule.targetLevel === 2 ? 2 : 1) as 1 | 2;
      const dueAt = rule.timeoutHours ? new Date(Date.now() + rule.timeoutHours * 3600 * 1000) : null;
      return {
        targetLevel,
        dueAt,
        matchedRuleId: rule.id,
        reason: `命中规则「${rule.name}」→ ${targetLevel}级审批`,
      };
    }
  }

  // 也查 category=all 的兜底规则
  const allRules = await db
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.enabled, true), eq(approvalRules.category, "all")))
    .orderBy(asc(approvalRules.priority));
  for (const rule of allRules) {
    const cfg = rule.conditionConfig as ConditionConfig;
    if (matches(cfg, opts)) {
      const targetLevel = (rule.targetLevel === 2 ? 2 : 1) as 1 | 2;
      const dueAt = rule.timeoutHours ? new Date(Date.now() + rule.timeoutHours * 3600 * 1000) : null;
      return { targetLevel, dueAt, matchedRuleId: rule.id, reason: `命中兜底规则「${rule.name}」→ ${targetLevel}级审批` };
    }
  }

  // 没有任何规则命中：物流默认 1 级（§6.1 保守），品控默认 2 级
  const fallbackLevel: 1 | 2 = opts.category === "quality_control" ? 2 : 1;
  return {
    targetLevel: fallbackLevel,
    dueAt: fallbackLevel === 1 ? new Date(Date.now() + 8 * 3600 * 1000) : new Date(Date.now() + 24 * 3600 * 1000),
    matchedRuleId: null,
    reason: `未命中规则，按默认 → ${fallbackLevel}级审批`,
  };
}

function matches(cfg: ConditionConfig, opts: { severity: Severity; estimatedAmount: number }): boolean {
  if (cfg.amountLte !== undefined && !(opts.estimatedAmount <= cfg.amountLte)) return false;
  if (cfg.amountGt !== undefined && !(opts.estimatedAmount > cfg.amountGt)) return false;
  if (cfg.severity) {
    const sev = cfg.severity.split(",").map((s) => s.trim()).filter(Boolean);
    if (sev.length > 0 && !sev.includes(opts.severity)) return false;
  }
  return true;
}

/** 工单上报后进入的第一个审批态：按路由结果决定起步层级 */
export function initialStatusForLevel(level: 1 | 2): TicketStatus {
  return level === 1 ? "level1_reviewing" : "level2_reviewing";
}

/**
 * 审批人资质校验（§3.11 自批自核、§5 层级匹配、§3.7 后端校验）。
 * 返回 { ok, reason }。
 */
export function validateApprover(opts: {
  user: SimpleUser;
  ticketStatus: TicketStatus;
  ticketReporterId: string | null;
  actionLevel: 1 | 2; // 当前提交的审批层级
}): { ok: boolean; reason?: string } {
  if (!opts.user) return { ok: false, reason: "用户不存在" };

  // 自批自核：审批人不能是上报人
  if (opts.ticketReporterId && opts.user.id === opts.ticketReporterId) {
    return { ok: false, reason: "不能审批自己上报的工单" };
  }

  const roles = opts.user.roleCodes;
  let allowed = false;
  if (opts.actionLevel === 1) {
    allowed = roles.includes("level1_approver") || roles.includes("level2_approver") || roles.includes("admin");
  } else {
    allowed = roles.includes("level2_approver") || roles.includes("admin");
  }
  if (!allowed) {
    return { ok: false, reason: `当前角色无 ${opts.actionLevel} 级审批权限` };
  }

  // 状态匹配：必须在对应 reviewing 状态
  if (opts.actionLevel === 1 && opts.ticketStatus !== "level1_reviewing") {
    return { ok: false, reason: `当前工单状态 ${opts.ticketStatus} 非 1 级审批中` };
  }
  if (opts.actionLevel === 2 && opts.ticketStatus !== "level2_reviewing") {
    return { ok: false, reason: `当前工单状态 ${opts.ticketStatus} 非 2 级审批中` };
  }

  return { ok: true };
}

/** 按 ticket route 结果，一级审批通过后决定继续升二级还是直接执行 */
export function level1ApproveNextStatus(opts: { amountExceeds: boolean; isHigh: boolean; }): "executing" | "level2_reviewing" {
  return opts.amountExceeds || opts.isHigh ? "level2_reviewing" : "executing";
}

/** 重提次数上限（§6.3）：拒绝最多重提 2 次，第 3 次拒绝后关闭 */
export const RESUBMIT_LIMIT = 2;
