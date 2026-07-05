/**
 * V3 最小种子脚本：7 个用户、5 条审批规则、10 条库存批次。
 * 用途：npm run db:seed
 * 注意：演示工单（200 条）由 seed-200-tickets.ts 单独脚本生成，后续轮次提供。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../src/lib/db";
import { users, approvalRules, inventoryItems } from "../src/lib/db-schema";

async function seed() {
  console.log("→ 清空旧数据…");
  await db.delete(inventoryItems);
  await db.delete(approvalRules);
  await db.delete(users);
  console.log("→ 重新写入种子…");

  // ====== 7 个用户（覆盖全部角色） ======
  const userRows = [
    { name: "操作员小张", roleCodes: "operator", warehouseId: "WH-01" },
    { name: "仓管员老李", roleCodes: "warehouse_operator", warehouseId: "WH-01" },
    { name: "品控主管王姐", roleCodes: "qc_supervisor" },
    { name: "一级审批陈哥", roleCodes: "level1_approver" },
    { name: "二级审批赵总", roleCodes: "level2_approver" },
    { name: "管理员钱主任", roleCodes: "admin,level2_approver" },
    { name: "审计孙老师", roleCodes: "auditor" },
  ];
  const insertedUsers = await db.insert(users).values(userRows).returning({ id: users.id, name: users.name });
  console.log(`  用户 ${insertedUsers.length} 条`);
  insertedUsers.forEach((u) => console.log(`    - ${u.name}: ${u.id}`));

  // ====== 5 条审批规则（§6.1 默认值） ======
  const ruleRows = [
    {
      name: "物流低金额走一级",
      category: "logistics",
      conditionConfig: { amountLte: 1000, severity: "low,medium" },
      targetLevel: 1,
      timeoutHours: 8,
      priority: 10,
    },
    {
      name: "物流高金额进二级",
      category: "logistics",
      conditionConfig: { amountGt: 1000 },
      targetLevel: 2,
      priority: 8,
    },
    {
      name: "任意 high 严重度进二级",
      category: "all",
      conditionConfig: { severity: "high" },
      targetLevel: 2,
      priority: 5,
    },
    {
      name: "品控异常默认二级",
      category: "quality_control",
      conditionConfig: {},
      targetLevel: 2,
      priority: 20,
    },
    {
      name: "二级审批超时上限",
      category: "all",
      conditionConfig: { level: 2 },
      targetLevel: 2,
      timeoutHours: 24,
      priority: 100,
    },
  ];
  const insertedRules = await db.insert(approvalRules).values(ruleRows).returning({ id: approvalRules.id, name: approvalRules.name });
  console.log(`  审批规则 ${insertedRules.length} 条`);

  // ====== 10 条库存批次 ======
  const batchRows = [
    { skuCode: "SKU-001", skuName: "无线蓝牙耳机", batchNo: "BATCH-001", availableQuantity: "200", status: "normal" },
    { skuCode: "SKU-002", skuName: "便携充电宝", batchNo: "BATCH-002", availableQuantity: "150", status: "normal" },
    { skuCode: "SKU-003", skuName: "机械键盘", batchNo: "BATCH-003", availableQuantity: "80", status: "normal" },
    { skuCode: "SKU-004", skuName: "高清摄像头", batchNo: "BATCH-004", availableQuantity: "120", status: "normal" },
    { skuCode: "SKU-005", skuName: "智能手环", batchNo: "BATCH-005", availableQuantity: "300", status: "normal" },
    { skuCode: "SKU-006", skuName: "USB-C 扩展坞", batchNo: "BATCH-006", availableQuantity: "0", status: "scrapped" },
    { skuCode: "SKU-007", skuName: "电竞鼠标", batchNo: "BATCH-007", availableQuantity: "60", status: "locked" },
    { skuCode: "SKU-008", skuName: "降噪耳机", batchNo: "BATCH-008", availableQuantity: "90", status: "normal" },
    { skuCode: "SKU-009", skuName: "车载支架", batchNo: "BATCH-009", availableQuantity: "0", status: "returned" },
    { skuCode: "SKU-010", skuName: "便携投影仪", batchNo: "BATCH-010", availableQuantity: "40", status: "normal" },
  ];
  const insertedBatches = await db.insert(inventoryItems).values(batchRows).returning({ id: inventoryItems.id, skuCode: inventoryItems.skuCode, batchNo: inventoryItems.batchNo });
  console.log(`  库存批次 ${insertedBatches.length} 条`);

  console.log("\n✅ V3 种子完成。请记住以下用户 ID 用于模拟登录切换角色：");
  insertedUsers.forEach((u) => console.log(`    ${u.name}: ${u.id}`));
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("种子失败:", err);
    process.exit(1);
  });
