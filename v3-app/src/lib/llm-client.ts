/**
 * OpenAI 兼容 LLM 客户端
 *
 * 支持任意 OpenAI-compatible API（OpenAI / 混元 / DeepSeek / Ollama 等）。
 * 通过环境变量配置：
 *   OPENAI_BASE_URL  — API 地址，默认 https://api.openai.com/v1
 *   OPENAI_API_KEY   — API 密钥（必填）
 *   OPENAI_MODEL     — 模型名，默认 gpt-4o-mini
 */

const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/** 是否已配置 LLM */
export function isLlmConfigured(): boolean {
  return !!API_KEY;
}

/** 当前使用的模型名 */
export function getLlmModelName(): string {
  return MODEL;
}

/** 完整的 API endpoint */
export function getLlmEndpoint(): string {
  return BASE_URL;
}

const SYSTEM_PROMPT = `你是一个物流异常工单审批辅助系统。你会收到一条工单信息，请根据描述给出专业建议。

## 异常子类型（从以下选项中选择最匹配的）：
- lost: 丢件/遗失
- damaged: 破损/损坏
- rejected: 拒收/拒签
- timeout_unsigned: 超时未签收
- address_error: 地址错误
- quantity_mismatch: 数量差异
- spec_mismatch: 规格不符
- label_mismatch: 标签错误
- batch_risk: 批次风险（召回/过期等）

## 严重度（从以下选项中选择）：
- low: 低
- medium: 中
- high: 高

## 要求
1. 根据问题描述判断最可能的异常子类型
2. 评估严重度
3. 给出一段简洁的审批建议（中文，80字以内），包含是否建议快速通过以及理由
4. 结合金额、严重度和重提次数综合判断
5. 小额（≤¥200）且低严重度通常建议快速通过
6. 重提工单需要更谨慎审核

请严格返回 JSON，不要包含 markdown 代码块标记。`;

export interface LlmClassification {
  subtype: string;
  subtypeConfidence: number;
  severity: string;
  severityConfidence: number;
  approvalSuggestion: string;
  suggestQuickApprove: boolean;
}

export interface LlmCallParams {
  description: string;
  estimatedAmount: number;
  status: string;
  resubmitCount: number;
}

/**
 * 调用 LLM 进行异常分类与审批建议
 */
export async function classifyWithLlm(params: LlmCallParams): Promise<LlmClassification> {
  if (!isLlmConfigured()) {
    throw new Error("LLM 未配置：请设置 OPENAI_API_KEY 环境变量");
  }

  const userMessage = [
    "请分析以下物流异常工单：",
    "",
    `问题描述：${params.description || "（无描述）"}`,
    `预估赔付金额：¥${params.estimatedAmount}`,
    `当前状态：${params.status}`,
    `已重提次数：${params.resubmitCount}`,
  ].join("\n");

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ticket_classification",
          strict: true,
          schema: {
            type: "object",
            properties: {
              subtype: {
                type: "string",
                enum: [
                  "lost", "damaged", "rejected", "timeout_unsigned",
                  "address_error", "quantity_mismatch", "spec_mismatch",
                  "label_mismatch", "batch_risk",
                ],
                description: "最可能的异常子类型",
              },
              subtypeConfidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "子类型判断置信度 0-1",
              },
              severity: {
                type: "string",
                enum: ["low", "medium", "high"],
                description: "推荐严重度",
              },
              severityConfidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "严重度判断置信度 0-1",
              },
              approvalSuggestion: {
                type: "string",
                description: "审批建议说明，中文，80字以内",
              },
              suggestQuickApprove: {
                type: "boolean",
                description: "是否建议快速通过",
              },
            },
            required: [
              "subtype", "subtypeConfidence", "severity",
              "severityConfidence", "approvalSuggestion", "suggestQuickApprove",
            ],
            additionalProperties: false,
          },
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM 调用失败 (${response.status}): ${body.slice(0, 200)}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM 返回空结果");
  }

  let parsed: LlmClassification;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 兼容部分不支持 json_schema 的端点，尝试从文本中提取 JSON
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM 返回格式无法解析");
    parsed = JSON.parse(match[0]);
  }

  // 校验必要字段
  if (!parsed.subtype || !parsed.severity || !parsed.approvalSuggestion) {
    throw new Error("LLM 返回缺少必要字段");
  }

  return {
    subtype: parsed.subtype,
    subtypeConfidence: Math.min(1, Math.max(0, parsed.subtypeConfidence ?? 0.7)),
    severity: parsed.severity,
    severityConfidence: Math.min(1, Math.max(0, parsed.severityConfidence ?? 0.7)),
    approvalSuggestion: parsed.approvalSuggestion,
    suggestQuickApprove: !!parsed.suggestQuickApprove,
  };
}
