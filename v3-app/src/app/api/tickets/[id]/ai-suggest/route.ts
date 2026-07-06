import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { exceptionTickets } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { generateAiAssistHybrid, generateAiAssist } from "@/lib/ai-assist";

/**
 * GET /api/tickets/[id]/ai-suggest — AI 辅助建议端点
 *
 * 混合策略：
 * 1. 关键词规则引擎（本地，零延迟）— 分类 + 模板建议
 * 2. 若 OPENAI_API_KEY 已配置，额外调用 LLM 获取智能审批建议
 * 3. LLM 调用失败时自动降级为纯规则模式
 *
 * 所有建议标注 "AI建议,需人工确认"。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const { id } = await params;

  try {
    const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
    if (!ticket) {
      return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });
    }

    const baseParams = {
      description: ticket.description ?? "",
      severity: ticket.severity,
      estimatedAmount: Number(ticket.estimatedAmount) || 0,
      subtype: ticket.subtype,
      status: ticket.status,
      resubmitCount: ticket.resubmitCount ?? 0,
    };

    // 尝试混合模式（关键词 + LLM）
    try {
      const result = await generateAiAssistHybrid(baseParams);
      return apiOk({
        ...result,
        disclaimer: "AI建议,需人工确认",
      });
    } catch {
      // 最终兜底：纯规则模式
      const result = generateAiAssist(baseParams);
      return apiOk({
        ...result,
        disclaimer: "AI建议,需人工确认",
        aiSource: { model: "rule-engine (keyword-based)", provider: "local" },
      });
    }
  } catch (e) {
    return apiError({
      code: "INTERNAL",
      message: `AI建议生成失败: ${(e as Error).message}`,
      status: 500,
    });
  }
}
