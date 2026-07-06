import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { users, exceptionTickets, approvalRecords, auditLogs } from "@/lib/db-schema";
import { eq, and, inArray } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";
import type { ApprovalAction } from "@/types";

/**
 * PATCH /api/users/[id] — 切换用户启用/禁用状态（仅 admin）
 * body: { enabled: boolean }
 *
 * 禁用用户时自动清理其名下的审批中工单（兜底机制）：
 *  - 一级工单 → 自动升级二级（清除 assignedApproverId）
 *  - 二级工单 → 清除 assignedApproverId（延长 4h 等待其他审批人认领）
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });
  if (!me.roleCodes.includes("admin")) {
    return apiError({ code: "FORBIDDEN", message: "仅管理员可操作", status: 403 });
  }

  const { id } = await params;

  try {
    const body = (await req.json()) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return apiError({ code: "BAD_REQUEST", message: "缺少 enabled 字段", status: 400 });
    }

    // 不允许禁用自己
    if (id === me.id && !body.enabled) {
      return apiError({ code: "BAD_REQUEST", message: "不能禁用当前登录的管理员账号", status: 400 });
    }

    const [targetUser] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!targetUser) {
      return apiError({ code: "NOT_FOUND", message: "用户不存在", status: 404 });
    }

    // ── 禁用兜底：清理该用户名下的审批中工单 ──
    let cleanedTickets = 0;
    if (!body.enabled /* 正在禁用 */ && targetUser.enabled /* 当前是启用的 */) {
      cleanedTickets = await cleanAssignedTickets(targetUser.id, targetUser.name, me.name, id);
    }

    const [updated] = await db
      .update(users)
      .set({ enabled: body.enabled })
      .where(eq(users.id, id))
      .returning({ id: users.id, name: users.name, enabled: users.enabled });

    if (!updated) {
      return apiError({ code: "NOT_FOUND", message: "用户不存在", status: 404 });
    }

    return apiOk({ ...updated, cleanedTickets });
  } catch (e) {
    return apiError({
      code: "INTERNAL",
      message: `操作失败: ${(e as Error).message}`,
      status: 500,
    });
  }
}

/** 清理被禁用用户名下处于审批中的工单 */
async function cleanAssignedTickets(
  disabledUserId: string,
  disabledUserName: string,
  operatorName: string,
  operatorId: string
): Promise<number> {
  // 查该用户名下处于审批中状态的工单
  const tickets = await db
    .select({ id: exceptionTickets.id, ticketNo: exceptionTickets.ticketNo, status: exceptionTickets.status, version: exceptionTickets.version, dueAt: exceptionTickets.dueAt })
    .from(exceptionTickets)
    .where(
      and(
        eq(exceptionTickets.assignedApproverId, disabledUserId),
        inArray(exceptionTickets.status, ["level1_reviewing", "level2_reviewing"])
      )
    )
    .execute();

  if (tickets.length === 0) return 0;

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const ticket of tickets) {
      const [current] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, ticket.id)).limit(1);
      if (!current || !["level1_reviewing", "level2_reviewing"].includes(current.status)) continue;

      const isLevel1 = current.status === "level1_reviewing";

      if (isLevel1) {
        // 一级工单：自动升级到二级
        const dueAt2 = new Date(now.getTime() + 24 * 3600 * 1000);
        await tx.update(exceptionTickets).set({
          status: "level2_reviewing",
          currentLevel: 2,
          assignedApproverId: null,
          version: Number(current.version) + 1,
          dueAt: dueAt2,
          lastActionAt: now,
          updatedAt: now,
        }).where(eq(exceptionTickets.id, ticket.id));

        await tx.insert(approvalRecords).values({
          id: crypto.randomUUID(),
          ticketId: ticket.id,
          approverId: null,
          level: 1,
          action: "transfer" as ApprovalAction,
          comment: `审批人「${disabledUserName}」账号已被管理员 ${operatorName} 禁用，自动升级二级`,
          fromStatus: "level1_reviewing",
          toStatus: "level2_reviewing",
        });
      } else {
        // 二级工单：清除审批人，延长截止时间
        const newDue = new Date(now.getTime() + 4 * 3600 * 1000);
        await tx.update(exceptionTickets).set({
          assignedApproverId: null,
          version: Number(current.version) + 1,
          dueAt: newDue,
          lastActionAt: now,
          updatedAt: now,
        }).where(eq(exceptionTickets.id, ticket.id));

        await tx.insert(approvalRecords).values({
          id: crypto.randomUUID(),
          ticketId: ticket.id,
          approverId: null,
          level: 2,
          action: "transfer" as ApprovalAction,
          comment: `审批人「${disabledUserName}」账号已被管理员 ${operatorName} 禁用，自动清除分配`,
          fromStatus: "level2_reviewing",
          toStatus: "level2_reviewing",
        });
      }

      // 审计日志
      await tx.insert(auditLogs).values({
        actorId: operatorId,
        targetType: "ticket",
        targetId: ticket.id,
        action: "approver_disabled_transfer",
        detail: {
          ticketNo: ticket.ticketNo,
          disabledApproverId: disabledUserId,
          disabledApproverName: disabledUserName,
          operatorName,
          action: isLevel1 ? "escalate_to_level2" : "clear_assignee",
        },
      });
    }
  });

  return tickets.length;
}
