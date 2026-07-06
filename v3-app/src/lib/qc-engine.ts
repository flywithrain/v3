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
  /** 结构化损伤等级（0=无，1-5级），优先于 description NLP 解析 */
  damageLevel?: number;
  /** 损伤部位：outer/内包装/inner/产品本体/product */
  damageLocation?: string;
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
      // 优先使用前端结构化输入的损伤等级，否则从 description NLP 解析
      const level = (input.damageLevel != null && input.damageLevel > 0)
        ? input.damageLevel
        : parseDamageLevel(input.description ?? "");
      if (level <= 0) return { hit: false, basis: {}, reason: "" };
      const minLevel = cfg.damageLevelMin ?? 2; // §6.5 默认 ≥2 触发
      const highLevel = cfg.damageLevelHigh ?? 4; // ≥4 直接 high
      const hit = level >= minLevel;
      return {
        hit,
        basis: { damageLevel: level, minLevel, highLevel, damageLocation: input.damageLocation ?? null, source: input.damageLevel != null ? "selector" : "nlp" },
        reason: hit ? `破损等级 ${level} ≥ ${minLevel}${input.damageLocation ? `（部位：${input.damageLocation}）` : ""}` : "",
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
      // 批次异常：检查 batchNo 是否命中风险关键词（召回/禁售/过期/质检/退货/销毁等）
      const batchNo = input.batchNo.toUpperCase();
      const riskKeywords = ["RECALL", "RISK-", "EXPIRED", "PROHIBITED", "QUARANTINE", "BANNED", "DESTROY", "REJECT", "DEFECT", "HOLD-"];
      const hit = riskKeywords.some((kw) => batchNo.includes(kw));
      return {
        hit,
        basis: { batchNo: input.batchNo, riskKeywords },
        reason: hit ? `批次号命中风险/召回/过期/禁售规则` : "",
      };
    }
    default:
      return { hit: false, basis: {}, reason: "" };
  }
}

/** 从描述文本中解析破损等级，支持多种自然语言模式：
 *  - "破损二级" / "破损2级"     → 2
 *  - "二级破损" / "2级破损"     → 2
 *  - "外包装二级破损"            → 2
 *  - "damage 3"                 → 3
 */
function parseDamageLevel(desc: string): number {
  const cnMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  // 1. "破损X级"（原版匹配）
  const m1 = desc.match(/破损([一二三四五六七八九])级/);
  if (m1) return cnMap[m1[1]] ?? 0;

  // 2. "X级破损"（如"二级破损"）
  const m2 = desc.match(/([一二三四五六七八九])级破损/);
  if (m2) return cnMap[m2[1]] ?? 0;

  // 3. 中文数字+级+任意内容+破损（如"外包装二级破损"、"物流二级破损"）
  const m3 = desc.match(/([一二三四五六七八九])级[^\s]*破损/);
  if (m3) return cnMap[m3[1]] ?? 0;

  // 4. 破损+任意内容+中文数字+级（如"破损外包装二级"）
  const m4 = desc.match(/破损[^\s]*([一二三四五六七八九])级/);
  if (m4) return cnMap[m4[1]] ?? 0;

  // 5. 阿拉伯数字+级（如"3级"、"2 级"）
  const m5 = desc.match(/(\d)[\s]*级/);
  if (m5) return Number(m5[1]) || 0;

  // 6. "破损"或"damage"后跟数字（原版兜底）
  const m6 = desc.match(/(?:破损|damage)[\s]*(\d)/i);
  if (m6) return Number(m6[1]) || 0;

  return 0;
}

/** 品控暂扣超时时长（§6.2）：2 小时 */
export const QC_HOLD_TIMEOUT_HOURS = 2;

/** 计算品控暂扣超时时间 */
export function calcHoldDueAt(): Date {
  return new Date(Date.now() + QC_HOLD_TIMEOUT_HOURS * 3600 * 1000);
}
