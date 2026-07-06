/**
 * V3 最小种子脚本：7 个用户、5 条审批规则、5 条品控规则、10 条库存批次。
 * 用途：npm run db:seed
 * 注意：演示工单（200 条）由 seed-200-tickets.ts 单独脚本生成。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../src/lib/db";
import { users, approvalRules, inventoryItems, qcRules, scanRecords, exceptionTickets, compensationRecords, inventoryMovements, approvalRecords, auditLogs, integrationLogs, waybillSnapshots, waybillSkuSnapshots } from "../src/lib/db-schema";

async function seed() {
  console.log("→ 清空旧数据…");
  // 按依赖顺序删除
  await db.delete(auditLogs);
  await db.delete(inventoryMovements);
  await db.delete(compensationRecords);
  await db.delete(approvalRecords);
  await db.delete(scanRecords);
  await db.delete(exceptionTickets);
  await db.delete(qcRules);
  await db.delete(approvalRules);
  await db.delete(inventoryItems);
  await db.delete(waybillSkuSnapshots);
  await db.delete(waybillSnapshots);
  await db.delete(integrationLogs);
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
      conditionConfig: { amountLte: 100, severity: "low,medium" },
      targetLevel: 1,
      timeoutHours: 8,
      priority: 10,
    },
    {
      name: "物流高金额进二级",
      category: "logistics",
      conditionConfig: { amountGt: 100 },
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

  // ====== §6.5 品控规则（7 条，按 priority 升序，首个命中即触发） ======
  const qcRuleRows = [
    // ---- priority 1~9：最高优先级，直接阻断 ----
    {
      name: "批次风险召回/禁售/过期",
      subtype: "batch_risk",
      conditionType: "batch_risk",
      conditionConfig: {},
      severity: "high",
      defaultApprovalLevel: 2,
      priority: 2,
    },
    // ---- priority 10~19：高/中严重度 ----
    {
      name: "数量差异≥5% 或数量不一致",
      subtype: "quantity_mismatch",
      conditionType: "quantity_diff",
      conditionConfig: { diffThresholdPct: 5 },
      severity: "medium",
      defaultApprovalLevel: 2,
      priority: 10,
    },
    {
      name: "标签SKU不一致",
      subtype: "label_mismatch",
      conditionType: "label_mismatch",
      conditionConfig: {},
      severity: "high",
      defaultApprovalLevel: 2,
      priority: 12,
    },
    {
      name: "规格不符",
      subtype: "spec_mismatch",
      conditionType: "spec_mismatch",
      conditionConfig: {},
      severity: "high",
      defaultApprovalLevel: 2,
      priority: 15,
    },
    {
      name: "外观破损≥4级",
      subtype: "damage",
      conditionType: "damage_level",
      conditionConfig: { damageLevelMin: 4, damageLevelHigh: 4 },
      severity: "high",
      defaultApprovalLevel: 2,
      priority: 18,
    },
    {
      name: "外观破损≥2级",
      subtype: "damage",
      conditionType: "damage_level",
      conditionConfig: { damageLevelMin: 2, damageLevelHigh: 4 },
      severity: "medium",
      defaultApprovalLevel: 2,
      priority: 20,
    },
    // ---- priority 20+：低严重度 ----
    {
      name: "外观破损1级（低风险）",
      subtype: "damage",
      conditionType: "damage_level",
      conditionConfig: { damageLevelMin: 1, damageLevelHigh: 2 },
      severity: "low",
      defaultApprovalLevel: 1,
      priority: 25,
    },
  ];
  const insertedQcRules = await db.insert(qcRules).values(qcRuleRows).returning({ id: qcRules.id, name: qcRules.name });
  console.log(`  品控规则 ${insertedQcRules.length} 条`);

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
    { skuCode: "SKU-011", skuName: "无线充电器", batchNo: "BATCH-011", availableQuantity: "180", status: "normal" },
    { skuCode: "SKU-012", skuName: "数据线套装", batchNo: "BATCH-012", availableQuantity: "500", status: "normal" },
    { skuCode: "SKU-013", skuName: "平板保护壳", batchNo: "BATCH-013", availableQuantity: "0", status: "returned" },
    { skuCode: "SKU-001", skuName: "无线蓝牙耳机", batchNo: "BATCH-014", availableQuantity: "100", status: "normal" },
    { skuCode: "SKU-014", skuName: "智能音箱", batchNo: "BATCH-015", availableQuantity: "75", status: "normal" },
    { skuCode: "SKU-015", skuName: "笔记本电脑支架", batchNo: "BATCH-016", availableQuantity: "120", status: "normal" },
    { skuCode: "SKU-003", skuName: "机械键盘", batchNo: "BATCH-017", availableQuantity: "0", status: "scrapped" },
    { skuCode: "SKU-016", skuName: "USB集线器", batchNo: "BATCH-018", availableQuantity: "200", status: "normal" },
    { skuCode: "SKU-017", skuName: "防蓝光眼镜", batchNo: "BATCH-019", availableQuantity: "45", status: "locked" },
    { skuCode: "SKU-018", skuName: "手机散热器", batchNo: "BATCH-020", availableQuantity: "90", status: "normal" },
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
