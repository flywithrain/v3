import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { exceptionTickets, integrationLogs, scanRecords } from "@/lib/db-schema";
import { eq, and, gte, desc, count, sql as drizzleSql } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";

/** GET /api/dashboard — 首页仪表盘统计（§11.1） */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  // 待我审批数量：按当前用户的层级 + 状态匹配
  const isL1 = me.roleCodes.includes("level1_approver") || me.roleCodes.includes("admin");
  const isL2 = me.roleCodes.includes("level2_approver") || me.roleCodes.includes("admin");

  const myApproveConds = [];
  if (isL1) myApproveConds.push(and(eq(exceptionTickets.status, "level1_reviewing"), drizzleSql`${exceptionTickets.reporterId} IS DISTINCT FROM ${me.id}`));
  if (isL2) myApproveConds.push(and(eq(exceptionTickets.status, "level2_reviewing"), drizzleSql`${exceptionTickets.reporterId} IS DISTINCT FROM ${me.id}`));

  let myApproveCount = 0;
  if (myApproveConds.length > 0) {
    const where = myApproveConds.length === 1 ? myApproveConds[0] : drizzleSql.join(myApproveConds, drizzleSql` OR `);
    const [c1] = await db.select({ c: count() }).from(exceptionTickets).where(where as never).execute();
    myApproveCount = Number(c1?.c ?? 0);
  }

  // 品控暂扣数量（查询 scan_records 中 qc_hold 状态的记录数）
  const [c4] = await db.select({ c: count() }).from(scanRecords).where(eq(scanRecords.qcStatus, "qc_hold")).execute();
  const qcHoldCount = Number(c4?.c ?? 0);

  // 今日新增异常
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [c2] = await db.select({ c: count() }).from(exceptionTickets).where(gte(exceptionTickets.createdAt, todayStart)).execute();
  const todayNew = Number(c2?.c ?? 0);

  // 即将超时工单（due_at 在未来 4 小时内）
  const soon = new Date(Date.now() + 4 * 3600 * 1000);
  const [c3] = await db
    .select({ c: count() })
    .from(exceptionTickets)
    .where(and(drizzleSql`${exceptionTickets.dueAt} IS NOT NULL`, gte(exceptionTickets.dueAt, new Date()), drizzleSql`${exceptionTickets.dueAt} <= ${soon}`, drizzleSql`${exceptionTickets.status} NOT IN ('completed','closed','auto_rejected_timeout','closed_rejected_limit')`))
    .execute();
  const dueSoon = Number(c3?.c ?? 0);

  // V2 最近同步时间 & 成功率
  const recentLogs = await db.select().from(integrationLogs).orderBy(desc(integrationLogs.createdAt)).limit(100);
  const lastSyncAt = recentLogs[0]?.createdAt ?? null;
  const successRate = recentLogs.length ? recentLogs.filter((r) => r.success).length / recentLogs.length : null;

  return apiOk({
    myApproveCount,
    qcHoldCount,
    todayNew,
    dueSoon,
    v2LastSyncAt: lastSyncAt,
    v2RecentSuccessRate: successRate,
    v2RecentCount: recentLogs.length,
    currentUser: me,
  });
}
