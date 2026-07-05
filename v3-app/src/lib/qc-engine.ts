import { db } from "@/lib/db";
import { qcRules } from "@/lib/db-schema";
import { eq, asc } from "drizzle-orm";
import type { QcSubtype, QcConditionType, Severity } from "@/types";

/**
 * 品控规则引擎：根据扫描入参匹配 qc_rules 表中的可配置规则，
 * 判定通过/异常，并返回命中规则 ID、严重度、判定依据。
 * §6.5 品控规则触发阈值；§3.4 规则可配置不硬编码。
 */

export interface QcScanInput {
  expectedQuantity: number;
  actualQuantity: number;
  expectedSpec: string | null;
  actualSpec: string | null;
  expectedSkuCode: string;
  actualSkuCode: string;
  batchNo: string;
  description?: string;
}

export interface QcMatchResult {
  passed: boolean;
  matchedRuleId: string | null;
  ruleName: string | null;
  subtype: QcSubtype | null;
  conditionType: QcConditionType | null;
  severity: Severity;
  decisionBasis: Record<string, unknown>;
  reason: string;
}

interface QcConditionConfig {
  diffThresholdPct?: number; // 数量差异百分比阈值
  damageLevelMin?: number; // 破损等级最小值
  damageLevelHigh?: number; // 破损等级直达 high 的阈值
}

/**
 * 执行品控规则匹配。按 priority 升序遍历 enabled 规则，首个命中即返回。
 * 未命中任何规则 → passed = true。
 */
export async function evaluateQcRules(input: QcScanInput): Promise<QcMatchResult> {
  const rules = await db
    .select()
    .from(qcRules)
    .where(eq(qcRules.enabled, true))
    .orderBy(asc(qcRules.priority));

  for (const rule of rules) {
    const cfg = rule.conditionConfig as QcConditionConfig;
    const result = matchRule(rule.conditionType as QcConditionType, cfg, input);
    if (result.hit) {
      return {
        passed: false,
        matchedRuleId: rule.id,
        ruleName: rule.name,
        subtype: rule.subtype as QcSubtype,
        conditionType: rule.conditionType as QcConditionType,
        severity: rule.severity as Severity,
        decisionBasis: result.basis,
        reason: `命中规则「${rule.name}」: ${result.reason}`,
      };
    }
  }

  return {
    passed: true,
    matchedRuleId: null,
    ruleName: null,
    subtype: null,
    conditionType: null,
    severity: "low",
    decisionBasis: { expectedQty: input.expectedQuantity, actualQty: input.actualQuantity, specMatch: input.expectedSpec === input.actualSpec },
    reason: "所有品控规则均未命中，判定通过",
  };
}

function matchRule(
  conditionType: QcConditionType,
  cfg: QcConditionConfig,
  input: QcScanInput
): { hit: boolean; basis: Record<string, unknown>; reason: string } {
  switch (conditionType) {
    case "quantity_diff": {
      const expected = Number(input.expectedQuantity) || 0;
      const actual = Number(input.actualQuantity) || 0;
      if (expected === 0 && actual === 0) return { hit: false, basis: {}, reason: "" };
      const diff = Math.abs(actual - expected);
      const diffPct = expected > 0 ? (diff / expected) * 100 : 100;
      const threshold = cfg.diffThresholdPct ?? 5; // §6.5 默认 5%
      const hit = expected !== actual || diffPct >= threshold;
      return {
        hit,
        basis: { expected, actual, diff, diffPct: Number(diffPct.toFixed(2)), threshold },
        reason: hit ? `数量差异 ${diffPct.toFixed(1)}% ≥ 阈值 ${threshold}%` : "",
      };
    }
    case "damage_level": {
      // 从 description 中提取破损等级（如"破损二级"→2）
      const level = parseDamageLevel(input.description ?? "");
      if (level <= 0) return { hit: false, basis: {}, reason: "" };
      const minLevel = cfg.damageLevelMin ?? 2; // §6.5 默认 ≥2 触发
      const highLevel = cfg.damageLevelHigh ?? 4; // ≥4 直接 high
      const hit = level >= minLevel;
      return {
        hit,
        basis: { damageLevel: level, minLevel, highLevel },
        reason: hit ? `破损等级 ${level} ≥ ${minLevel}` : "",
      };
    }
    case "spec_mismatch": {
      const expected = input.expectedSpec?.trim() ?? "";
      const actual = input.actualSpec?.trim() ?? "";
      const hit = expected !== "" && actual !== "" && expected !== actual;
      return {
        hit,
        basis: { expectedSpec: expected, actualSpec: actual },
        reason: hit ? `规格不一致: 期望「${expected}」实际「${actual}」` : "",
      };
    }
    case "label_mismatch": {
      const expected = input.expectedSkuCode.trim();
      const actual = input.actualSkuCode.trim();
      const hit = expected !== actual;
      return {
        hit,
        basis: { expectedSku: expected, actualSku: actual },
        reason: hit ? `标签 SKU 不一致: 期望「${expected}」实际「${actual}」` : "",
      };
    }
    case "batch_risk": {
      // 批次异常：检查 batchNo 是否命中风险名单（简化：以 RISK- 开头或包含 recall）
      const batchNo = input.batchNo.toUpperCase();
      const hit = batchNo.includes("RECALL") || batchNo.startsWith("RISK-") || batchNo.includes("EXPIRED");
      return {
        hit,
        basis: { batchNo: input.batchNo },
        reason: hit ? `批次号命中风险/召回/过期规则` : "",
      };
    }
    default:
      return { hit: false, basis: {}, reason: "" };
  }
}

/** 从描述文本中解析破损等级，如"破损二级"→2、"破损4级"→4 */
function parseDamageLevel(desc: string): number {
  const cnMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
  const m1 = desc.match(/破损[一二三四五]级/);
  if (m1) return cnMap[m1[0][1]] ?? 0;
  const m2 = desc.match(/(?:破损|damage)[\s]*(\d)/i);
  if (m2) return Number(m2[1]) || 0;
  return 0;
}

/** 品控暂扣超时时长（§6.2）：2 小时 */
export const QC_HOLD_TIMEOUT_HOURS = 2;

/** 计算品控暂扣超时时间 */
export function calcHoldDueAt(): Date {
  return new Date(Date.now() + QC_HOLD_TIMEOUT_HOURS * 3600 * 1000);
}
