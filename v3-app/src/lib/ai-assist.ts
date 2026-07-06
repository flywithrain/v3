/**
 * AI 辅助建议引擎（关键词规则 + OpenAI 兼容 LLM）
 *
 * 策略：
 * 1. 始终先运行关键词规则（本地，零延迟）
 * 2. 如果配置了 LLM，额外调用获取智能审批建议文本
 * 3. LLM 失败时自动降级为纯规则模式
 *
 * 所有建议标注 "AI建议,需人工确认"。
 */

export interface AiAssistResult {
  /** 推荐的异常子类型 */
  suggestedSubtype: string;
  /** 子类型推荐置信度 (0-1) */
  subtypeConfidence: number;
  /** 推荐的严重度 */
  suggestedSeverity: string;
  /** 严重度推荐置信度 (0-1) */
  severityConfidence: number;
  /** 审批建议说明 */
  approvalSuggestion: string;
  /** 是否建议快速通过 */
  suggestQuickApprove: boolean;
  /** 匹配到的关键词列表 */
  matchedKeywords: string[];
  /** 生成时间 */
  generatedAt: string;
}

// 关键词 → 子类型映射
const KEYWORD_SUBTYPE_MAP: Array<{ keywords: string[]; subtype: string; severity: string }> = [
  { keywords: ["丢件", "丢失", "找不到", "遗失", "没收到", "丢了"], subtype: "lost", severity: "high" },
  { keywords: ["破损", "损坏", "摔坏", "碎了", "破了", "压坏", "磕碰", "断裂"], subtype: "damaged", severity: "medium" },
  { keywords: ["拒收", "拒签", "客户拒收", "拒付"], subtype: "rejected", severity: "medium" },
  { keywords: ["超时", "未签收", "超期", "延迟签收", "没签"], subtype: "timeout_unsigned", severity: "low" },
  { keywords: ["地址", "地址错误", "地址不详", "地址变更", "搬家"], subtype: "address_error", severity: "medium" },
  { keywords: ["数量", "少发", "缺货", "少货", "短少", "差异", "多件"], subtype: "quantity_mismatch", severity: "medium" },
  { keywords: ["规格", "不符", "型号不对", "颜色不对", "尺寸不对", "发错"], subtype: "spec_mismatch", severity: "high" },
  { keywords: ["标签", "条码", "二维码", "贴错", "标错", "标签不一致"], subtype: "label_mismatch", severity: "high" },
  { keywords: ["批次", "召回", "风险", "过期", "变质", "临期"], subtype: "batch_risk", severity: "high" },
  { keywords: ["外观", "划痕", "污渍", "脏", "瑕疵", "磨损"], subtype: "damage", severity: "medium" },
];

/**
 * 根据异常描述文本推荐子类型和严重度
 */
export function suggestSubtypeAndSeverity(description: string): {
  suggestedSubtype: string;
  subtypeConfidence: number;
  suggestedSeverity: string;
  severityConfidence: number;
  matchedKeywords: string[];
} {
  const text = (description ?? "").trim();
  if (!text) {
    return {
      suggestedSubtype: "lost",
      subtypeConfidence: 0.1,
      suggestedSeverity: "medium",
      severityConfidence: 0.1,
      matchedKeywords: [],
    };
  }

  const keywordMatches: Array<{ subtype: string; severity: string; count: number }> = [];
  const matchedKeywords: string[] = [];

  for (const rule of KEYWORD_SUBTYPE_MAP) {
    let count = 0;
    for (const kw of rule.keywords) {
      if (text.includes(kw)) {
        count++;
        matchedKeywords.push(kw);
      }
    }
    if (count > 0) {
      keywordMatches.push({ subtype: rule.subtype, severity: rule.severity, count });
    }
  }

  if (keywordMatches.length === 0) {
    return {
      suggestedSubtype: "lost",
      subtypeConfidence: 0.15,
      suggestedSeverity: "low",
      severityConfidence: 0.1,
      matchedKeywords: [],
    };
  }

  // 按匹配数排序，取最高
  keywordMatches.sort((a, b) => b.count - a.count);
  const best = keywordMatches[0];
  const maxPossible = KEYWORD_SUBTYPE_MAP.find((r) => r.subtype === best.subtype)?.keywords.length ?? 5;

  return {
    suggestedSubtype: best.subtype,
    subtypeConfidence: Math.min(0.9, best.count / maxPossible + 0.3),
    suggestedSeverity: best.severity,
    severityConfidence: 0.6 + keywordMatches.length * 0.1,
    matchedKeywords,
  };
}

/**
 * 生成审批建议说明
 */
export function generateApprovalSuggestion(params: {
  severity: string;
  estimatedAmount: number;
  subtype: string;
  status: string;
  resubmitCount: number;
  description: string;
}): { approvalSuggestion: string; suggestQuickApprove: boolean } {
  const parts: string[] = [];
  let quickApprove = false;

  // 金额分析
  const amount = params.estimatedAmount || 0;
  if (amount <= 200) {
    parts.push("小额赔付（≤¥200），建议快速处理，确认事实后即可通过");
    quickApprove = true;
  } else if (amount <= 1000) {
    parts.push("中等金额赔付（¥200-1000），建议核对运单快照和问题描述后审批");
  } else {
    parts.push("大额赔付（>¥1000），建议仔细核实证据，必要时要求补充材料");
  }

  // 严重度分析
  switch (params.severity) {
    case "low":
      parts.push("严重度低，可在核实描述真实性后通过");
      break;
    case "medium":
      parts.push("严重度中等，建议关注历史同类工单处理结果");
      break;
    case "high":
      parts.push("严重度高，建议严格审核证据链，考虑是否需要现场复核");
      break;
  }

  // 重提分析
  if (params.resubmitCount > 0) {
    parts.push(`该工单已重提 ${params.resubmitCount} 次，请对比前次审批意见评估是否满足条件`);
    quickApprove = false;
  }

  // 状态相关
  if (params.status === "level2_reviewing") {
    parts.push("当前为二级审批，上一级已通过，本级的审核重点是是否满足公司赔付政策");
  }

  return {
    approvalSuggestion: parts.join("。"),
    suggestQuickApprove: quickApprove,
  };
}

/**
 * 综合 AI 辅助建议（纯规则，同步）
 */
export function generateAiAssist(params: {
  description: string;
  severity: string;
  estimatedAmount: number;
  subtype: string;
  status: string;
  resubmitCount: number;
}): AiAssistResult {
  const subtypeResult = suggestSubtypeAndSeverity(params.description);
  const approvalResult = generateApprovalSuggestion({
    severity: params.severity,
    estimatedAmount: params.estimatedAmount,
    subtype: params.subtype,
    status: params.status,
    resubmitCount: params.resubmitCount,
    description: params.description,
  });

  return {
    suggestedSubtype: subtypeResult.suggestedSubtype,
    subtypeConfidence: Math.round(subtypeResult.subtypeConfidence * 100) / 100,
    suggestedSeverity: subtypeResult.suggestedSeverity,
    severityConfidence: Math.round(subtypeResult.severityConfidence * 100) / 100,
    approvalSuggestion: approvalResult.approvalSuggestion,
    suggestQuickApprove: approvalResult.suggestQuickApprove,
    matchedKeywords: subtypeResult.matchedKeywords,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 获取 AI 建议的来源信息
 */
export function getAiSource(): { model: string; provider: string } {
  // 动态导入避免循环依赖
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isLlmConfigured, getLlmModelName, getLlmEndpoint } = require("./llm-client") as typeof import("./llm-client");
  if (isLlmConfigured()) {
    return { model: getLlmModelName(), provider: getLlmEndpoint() };
  }
  return { model: "rule-engine (keyword-based)", provider: "local" };
}

/**
 * 混合 AI 建议（关键词 + LLM）
 *
 * 始终运行关键词引擎（零延迟），如果 LLM 可用则额外调用增强审批建议。
 * LLM 失败时自动降级，返回规则引擎的结果。
 */
export async function generateAiAssistHybrid(params: {
  description: string;
  severity: string;
  estimatedAmount: number;
  subtype: string;
  status: string;
  resubmitCount: number;
}): Promise<AiAssistResult & { aiSource: { model: string; provider: string } }> {
  const { isLlmConfigured, classifyWithLlm, getLlmModelName, getLlmEndpoint } =
    await import("./llm-client");

  // 1. 始终先跑关键词规则（本地，零延迟）
  const ruleResult = generateAiAssist(params);

  if (!isLlmConfigured()) {
    return {
      ...ruleResult,
      aiSource: { model: "rule-engine (keyword-based)", provider: "local" },
    };
  }

  // 2. 调用 LLM 获取智能审批建议
  try {
    const llmResult = await classifyWithLlm({
      description: params.description,
      estimatedAmount: params.estimatedAmount,
      status: params.status,
      resubmitCount: params.resubmitCount,
    });

    // 用 LLM 的审批建议替换规则模板建议
    return {
      suggestedSubtype: llmResult.subtype || ruleResult.suggestedSubtype,
      subtypeConfidence: llmResult.subtypeConfidence ?? ruleResult.subtypeConfidence,
      suggestedSeverity: llmResult.severity || ruleResult.suggestedSeverity,
      severityConfidence: llmResult.severityConfidence ?? ruleResult.severityConfidence,
      approvalSuggestion: llmResult.approvalSuggestion,
      suggestQuickApprove: llmResult.suggestQuickApprove,
      matchedKeywords: ruleResult.matchedKeywords,
      generatedAt: new Date().toISOString(),
      aiSource: { model: getLlmModelName(), provider: getLlmEndpoint() },
    };
  } catch {
    // LLM 失败，降级为纯规则结果
    console.warn("[ai-assist] LLM 调用失败，降级为规则引擎");
    return {
      ...ruleResult,
      aiSource: { model: `rule-engine (fallback from ${getLlmModelName()})`, provider: "local" },
    };
  }
}
