import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { exceptionTickets, approvalRecords } from "@/lib/db-schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import { validateApprover, RESUBMIT_LIMIT } from "@/lib/approval-engine";
import { assertCanApproveAtLevel, canTransition } from "@/lib/state-machine";
import { findExistingByKey } from "@/lib/idempotency";

/**
 * POST /api/tickets/[id]/reject — 审批拒绝（§10.3）
 * 头：Idempotency-Key
 * 入参：{ comment, expectedVersion, level }
 * 拒绝后：
 *  - resubmitCount < 2 → rejected 状态，允许重提
 *  - resubmitCount >= 2 → closed_rejected_limit（§6.3）
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

  let body: { comment?: string; expectedVersion?: number; level?: 1 | 2 } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const expectedVersion = Number(body.expectedVersion);
  const comment = body.comment?.trim() ?? "";

  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
  if (!ticket) return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });

  if (Number(expectedVersion) !== Number(ticket.version)) {
    return apiError({
      code: "TICKET_VERSION_CONFLICT",
      message: "该工单已被其他人处理，请刷新后查看最新状态",
      status: 409,
    });
  }

  const actionLevel: 1 | 2 = body.level ?? (ticket.currentLevel === 2 ? 2 : 1);

  const v = validateApprover({
    user: me,
    ticketStatus: ticket.status as "level1_reviewing" | "level2_reviewing",
    ticketReporterId: ticket.reporterId ?? null,
    actionLevel,
  });
  if (!v.ok) return apiError({ code: "FORBIDDEN", message: v.reason ?? "无权限", status: 403 });

  const ok = assertCanApproveAtLevel(ticket.status as "level1_reviewing" | "level2_reviewing", actionLevel);
  if (!ok.ok) return apiError({ code: "INVALID_STATE_TRANSITION", message: ok.reason ?? "状态不允许审批", status: 409 });

  // 决定拒绝后状态：累计 resubmitCount 达上限 → closed_rejected_limit，否则 rejected
  const currentResubmit = Number(ticket.resubmitCount ?? 0);
  const nextStatus = currentResubmit >= RESUBMIT_LIMIT ? "closed_rejected_limit" : "rejected";

  if (!canTransition(ticket.status as never, nextStatus as never, "logistics")) {
    return apiError({ code: "INVALID_STATE_TRANSITION", message: `不允许 ${ticket.status} -> ${nextStatus}`, status: 409 });
  }

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
        level: actionLevel,
        action: "reject",
        comment: comment || null,
        fromStatus: ticket.status,
        toStatus: nextStatus,
        idempotencyKey: idempotencyKey ?? null,
      });

      const newVersion = Number(cur.version) + 1;
      await tx
        .update(exceptionTickets)
        .set({
          status: nextStatus,
          currentLevel: 0,
          resubmitCount: currentResubmit + 1,
          version: newVersion,
          lastActionAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exceptionTickets.id, id));
    });

    return apiOk({
      ok: true,
      approvalRecordId,
      fromStatus: ticket.status,
      toStatus: nextStatus,
      resubmitCount: currentResubmit + 1,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "TICKET_VERSION_CONFLICT") {
      return apiError({ code: "TICKET_VERSION_CONFLICT", message: "该工单已被其他人处理，请刷新后查看最新状态", status: 409 });
    }
    console.error("[reject] 失败:", e);
    return apiError({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e), status: 500 });
  }
}
