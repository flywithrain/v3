import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { exceptionTickets, approvalRecords } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { canTransition } from "@/lib/state-machine";
import { findExistingByKey } from "@/lib/idempotency";
import { routeApproval, initialStatusForLevel } from "@/lib/approval-engine";

/**
 * POST /api/tickets/[id]/resubmit — 拒绝后重提（§7.1 rejected -> pending_review）
 * 头：Idempotency-Key
 * 入参：{ comment, expectedVersion, severity?, estimatedAmount?, description? }
 * 仅上报人本人或 admin 可重提；重提次数已耗尽（状态为 closed_rejected_limit）则禁止。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录或会话失效", status: 401 });

  const { id } = await params;
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || null;

  if (idempotencyKey) {
    const existing = await findExistingByKey(idempotencyKey);
    if (existing && existing.ticketId === id) {
      return apiOk({ idempotent: true, approvalRecordId: existing.id, action: existing.action });
    }
  }

  let body: { comment?: string; expectedVersion?: number; severity?: string; estimatedAmount?: number; description?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const expectedVersion = Number(body.expectedVersion);

  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
  if (!ticket) return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });

  // 仅上报人或 admin 可重提
  const isReporter = ticket.reporterId === me.id;
  const isAdmin = me.roleCodes.includes("admin");
  if (!isReporter && !isAdmin) {
    return apiError({ code: "FORBIDDEN", message: "仅上报人或管理员可重提工单", status: 403 });
  }
  if (ticket.status === "closed_rejected_limit") {
    return apiError({ code: "RESUBMIT_LIMIT_REACHED", message: "重提次数已耗尽，工单已关闭", status: 409 });
  }
  if (!canTransition(ticket.status as never, "pending_review" as never, "logistics")) {
    return apiError({ code: "INVALID_STATE_TRANSITION", message: `仅 rejected/auto_rejected_timeout 状态可重提，当前为 ${ticket.status}`, status: 409 });
  }
  if (Number(expectedVersion) !== Number(ticket.version)) {
    return apiError({ code: "TICKET_VERSION_CONFLICT", message: "该工单已被其他人处理，请刷新后查看最新状态", status: 409 });
  }

  // 若重提时改了 severity/amount/description，重新路由审批层级
  const newSeverity = (body.severity ?? ticket.severity) as "low" | "medium" | "high";
  const newAmount = body.estimatedAmount !== undefined ? Number(body.estimatedAmount) : Number(ticket.estimatedAmount);
  const newDescription = body.description?.trim() || ticket.description;
  const route = await routeApproval({ category: "logistics", subtype: ticket.subtype, severity: newSeverity, estimatedAmount: newAmount });

  try {
    const approvalRecordId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
      if (!cur) throw new Error("工单不存在");
      if (Number(cur.version) !== Number(expectedVersion)) {
        throw Object.assign(new Error("TICKET_VERSION_CONFLICT"), { code: "TICKET_VERSION_CONFLICT" });
      }

      await tx.insert(approvalRecords).values({
        id: approvalRecordId,
        ticketId: id,
        approverId: me.id,
        level: null,
        action: "approve",
        comment: body.comment?.trim() || "提交重提",
        fromStatus: ticket.status,
        toStatus: initialStatusForLevel(route.targetLevel),
        idempotencyKey: idempotencyKey ?? null,
      });

      const newVersion = Number(cur.version) + 1;
      await tx
        .update(exceptionTickets)
        .set({
          status: initialStatusForLevel(route.targetLevel),
          currentLevel: route.targetLevel,
          severity: newSeverity,
          estimatedAmount: String(newAmount),
          description: newDescription,
          version: newVersion,
          dueAt: route.dueAt,
          lastActionAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exceptionTickets.id, id));
    });

    return apiOk({
      ok: true,
      approvalRecordId,
      fromStatus: ticket.status,
      toStatus: initialStatusForLevel(route.targetLevel),
      routeReason: route.reason,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "TICKET_VERSION_CONFLICT") {
      return apiError({ code: "TICKET_VERSION_CONFLICT", message: "该工单已被其他人处理，请刷新后查看最新状态", status: 409 });
    }
    console.error("[resubmit] 失败:", e);
    return apiError({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e), status: 500 });
  }
}
