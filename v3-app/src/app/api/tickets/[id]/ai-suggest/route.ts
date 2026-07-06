import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { exceptionTickets } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { generateAiAssist } from "@/lib/ai-assist";

/**
 * GET /api/tickets/[id]/ai-suggest — AI 辅助建议端点
 *
 * 基于工单的异常描述、金额、严重度等信息，通过关键词规则引擎给出：
 * 1. 异常类型与严重度推荐建议
 * 2. 审批建议说明
 *
 * 所有建议标注 "AI建议,需人工确认"。
 * AI 失败不阻塞主流程，返回空建议。
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

    const result = generateAiAssist({
      description: ticket.description ?? "",
      severity: ticket.severity,
      estimatedAmount: Number(ticket.estimatedAmount) || 0,
      subtype: ticket.subtype,
      status: ticket.status,
      resubmitCount: ticket.resubmitCount ?? 0,
    });

    return apiOk({
      ...result,
      disclaimer: "AI建议,需人工确认",
      model: "rule-engine (keyword-based)",
    });
  } catch (e) {
    return apiError({
      code: "INTERNAL",
      message: `AI建议生成失败: ${(e as Error).message}`,
      status: 500,
    });
  }
}
