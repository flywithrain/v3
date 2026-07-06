/**
 * 检查审批人禁用兜底逻辑的数据现状
 * 用法：npx tsx scripts/check-disabled-approver.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const [{ db }, schema, { eq, and, sql, inArray }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/db-schema"),
    import("drizzle-orm"),
  ]);
  const { users, exceptionTickets } = schema;

  // 1. 所有用户状态
  console.log("=== 所有用户 ===");
  const allUsers = await db.select({ id: users.id, name: users.name, enabled: users.enabled, roles: users.roleCodes }).from(users);
  console.table(allUsers.map(u => ({ ...u, id: u.id.substring(0,8), roles: u.roles.substring(0,40) })));

  // 2. 已分配审批人的审批中工单
  console.log("\n=== 已分配 assignedApproverId 的审批中工单 ===");
  const assigned = await db.select({
    ticketNo: exceptionTickets.ticketNo,
    status: exceptionTickets.status,
    assignedApproverId: exceptionTickets.assignedApproverId,
    dueAt: exceptionTickets.dueAt,
  })
    .from(exceptionTickets)
    .where(and(
      sql`assigned_approver_id IS NOT NULL`,
      inArray(exceptionTickets.status, ["level1_reviewing", "level2_reviewing"])
    ));
  console.log(`${assigned.length} 条工单有 assignedApproverId`);
  if (assigned.length > 0) console.table(assigned.map(a => ({ ...a, assignedApproverId: a.assignedApproverId?.substring(0,8) ?? null })));

  // 3. 审批人状态 JOIN
  console.log("\n=== 审批人工单分配状态 (审批中工单 JOIN 审批人) ===");
  const joined = await db.select({
    ticketNo: exceptionTickets.ticketNo,
    ticketStatus: exceptionTickets.status,
    approverName: users.name,
    approverEnabled: users.enabled,
  })
    .from(exceptionTickets)
    .leftJoin(users, eq(exceptionTickets.assignedApproverId, users.id))
    .where(inArray(exceptionTickets.status, ["level1_reviewing", "level2_reviewing"]))
    .limit(30);
  console.table(joined);

  // 4. 检查：有审批中工单但 assignedApproverId = null 的数量
  console.log("\n=== 统计 === ");
  const [{ cnt: totalReviewing }] = await db.select({ cnt: sql`count(*)` }).from(exceptionTickets)
    .where(inArray(exceptionTickets.status, ["level1_reviewing", "level2_reviewing"]));
  const [{ cnt: totalAssigned }] = await db.select({ cnt: sql`count(*)` }).from(exceptionTickets)
    .where(and(sql`assigned_approver_id IS NOT NULL`, inArray(exceptionTickets.status, ["level1_reviewing", "level2_reviewing"])));
  console.log(`审批中工单总数: ${totalReviewing}`);
  console.log(`其中已分配审批人: ${totalAssigned}`);
  console.log(`其中未分配审批人 (pool模式): ${Number(totalReviewing) - Number(totalAssigned)}`);

  process.exit(0);
}
main();
