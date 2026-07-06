import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  exceptionTickets,
  approvalRecords,
  users,
  auditLogs,
} from "@/lib/db-schema";
import { eq, and, or } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError, requireRoles } from "@/lib/auth";
import type { ApprovalAction } from "@/types";

/**
 * POST /api/tickets/[id]/transfer — 管理员转交审批人（§11.5）
 * 在审批中状态（level1_reviewing/level2_reviewing）时可转交给其他审批人。
 * 事务内：更新 assigned_approver_id + 写 approval_records(action=transfer) + 写 audit_logs
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  const forbidden = requireRoles(me, "admin");
  if (forbidden) return forbidden;

  const { id } = await params;

  let body: { targetApproverId?: string; comment?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { targetApproverId, comment } = body;
  if (!targetApproverId?.trim()) {
    return apiError({ code: "BAD_REQUEST", message: "需提供目标审批人 ID", status: 400 });
  }

  // 校验目标审批人存在且启用
  const [targetUser] = await db.select().from(users).where(eq(users.id, targetApproverId.trim())).limit(1);
  if (!targetUser || !targetUser.enabled) {
    return apiError({ code: "BAD_REQUEST", message: "目标审批人不存在或已禁用", status: 400 });
  }

  const targetRoles = targetUser.roleCodes.split(",").map((s) => s.trim());
  if (!targetRoles.includes("level1_approver") && !targetRoles.includes("level2_approver")) {
    return apiError({ code: "BAD_REQUEST", message: "目标用户不是审批人角色", status: 400 });
  }

  // 查工单
  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
  if (!ticket) {
    return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });
  }

  const reviewingStatuses = ["level1_reviewing", "level2_reviewing"];
  if (!reviewingStatuses.includes(ticket.status)) {
    return apiError({ code: "INVALID_STATE_TRANSITION", message: "仅审批中状态的工单支持转交", status: 400 });
  }

  const now = new Date();

  // 事务：更新 assigned_approver_id + 写审批记录 + 审计日志
  await db.transaction(async (tx) => {
    // 乐观锁重读
    const [current] = await tx.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
    if (!current || !reviewingStatuses.includes(current.status)) {
      throw new Error("STATE_CHANGED");
    }

    // 更新审批人
    await tx
      .update(exceptionTickets)
      .set({
        assignedApproverId: targetApproverId.trim(),
        version: Number(current.version) + 1,
        lastActionAt: now,
        updatedAt: now,
      })
      .where(eq(exceptionTickets.id, id));

    // 写审批记录
    await tx.insert(approvalRecords).values({
      id: crypto.randomUUID(),
      ticketId: id,
      approverId: me!.id,
      level: ticket.currentLevel,
      action: "transfer" as ApprovalAction,
      comment: comment?.trim() ||
        `管理员 ${me!.name} 转交给审批人 ${targetUser.name}`,
      fromStatus: ticket.status,
      toStatus: ticket.status,
    });

    // 写审计日志
    await tx.insert(auditLogs).values({
      actorId: me!.id,
      targetType: "ticket",
      targetId: id,
      action: "transfer_approver",
      detail: {
        ticketNo: ticket.ticketNo,
        fromApproverId: ticket.assignedApproverId ?? "(无)",
        toApproverId: targetApproverId.trim(),
        toApproverName: targetUser.name,
        reason: comment?.trim() || null,
      },
    });
  });

  return apiOk({
    ticketId: id,
    newApproverId: targetApproverId.trim(),
    newApproverName: targetUser.name,
    version: Number(ticket.version) + 1,
  });
}

/**
 * GET /api/tickets/[id]/transfer — 获取可转交的审批人列表
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser(req);
  const forbidden = requireRoles(me, "admin");
  if (forbidden) return forbidden;

  const { id } = await params;

  // 查工单当前层级确定需要的审批人角色
  const [ticket] = await db.select().from(exceptionTickets).where(eq(exceptionTickets.id, id)).limit(1);
  if (!ticket) {
    return apiError({ code: "NOT_FOUND", message: "工单不存在", status: 404 });
  }

  // 根据工单当前层级过滤合适的审批人
  const neededRole = ticket.currentLevel === 1 ? "level1_approver" : "level2_approver";

  const candidates = await db
    .select({ id: users.id, name: users.name, roleCodes: users.roleCodes })
    .from(users)
    .where(
      and(
        eq(users.enabled, true),
        or(
          eq(users.roleCodes, neededRole),
          eq(users.roleCodes, `admin,${neededRole}`),
          eq(users.roleCodes, `${neededRole},admin`)
        )
      )
    );

  // 也包含 admin 角色用户
  const admins = await db
    .select({ id: users.id, name: users.name, roleCodes: users.roleCodes })
    .from(users)
    .where(eq(users.roleCodes, "admin"));

  // 合并去重
  const seen = new Set(candidates.map((c) => c.id));
  const allCandidates = [...candidates];
  for (const a of admins) {
    if (!seen.has(a.id)) {
      allCandidates.push(a);
      seen.add(a.id);
    }
  }

  // 排除当前审批人自己
  const filtered = ticket.assignedApproverId
    ? allCandidates.filter((c) => c.id !== ticket.assignedApproverId)
    : allCandidates;

  return apiOk({
    currentApproverId: ticket.assignedApproverId,
    currentLevel: ticket.currentLevel,
    candidates: filtered,
  });
}
