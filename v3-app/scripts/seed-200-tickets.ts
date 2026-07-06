/**
 * V3 演示数据种子：生成 200+ 条异常工单，覆盖各种状态、类型、审批层级。
 * 用途：npm run seed:demo
 *
 * 性能优化：全部使用批量插入，避免循环内逐条 DB 调用。
 * 200 条工单从 ~1000+ 次 DB 往返优化为 ~8 次批量操作。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../src/lib/db";
import {
  users,
  waybillSnapshots,
  waybillSkuSnapshots,
  exceptionTickets,
  approvalRecords,
  compensationRecords,
  inventoryMovements,
  scanRecords,
  auditLogs,
} from "../src/lib/db-schema";

const LOGISTICS_SUBTYPES = ["lost", "damaged", "rejected", "timeout_unsigned", "address_error"];
const QC_SUBTYPES = ["quantity_mismatch", "damage", "spec_mismatch", "label_mismatch", "batch_risk"];
const SEVERITIES = ["low", "medium", "high"];
const STATUSES = [
  "pending_review", "level1_reviewing", "level2_reviewing",
  "rejected", "executing", "completed", "closed",
  "auto_rejected_timeout", "closed_rejected_limit",
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seed() {
  const t0 = Date.now();
  console.log("→ 查询用户…");
  const allUsers = await db.select().from(users);
  if (allUsers.length === 0) {
    console.error("请先运行 npm run db:seed 创建基础种子！");
    process.exit(1);
  }

  const operator = allUsers.find((u) => u.roleCodes.includes("operator")) ?? allUsers[0];
  const warehouseOp = allUsers.find((u) => u.roleCodes.includes("warehouse_operator")) ?? allUsers[0];
  const level1 = allUsers.find((u) => u.roleCodes.includes("level1_approver")) ?? allUsers[0];
  const level2 = allUsers.find((u) => u.roleCodes.includes("level2_approver")) ?? allUsers[0];

  console.log("→ 清空旧工单数据…");
  await db.delete(auditLogs);
  await db.delete(inventoryMovements);
  await db.delete(compensationRecords);
  await db.delete(scanRecords);
  await db.delete(approvalRecords);
  await db.delete(exceptionTickets);
  await db.delete(waybillSkuSnapshots);
  await db.delete(waybillSnapshots);

  // ====== 批量生成运单快照（20 条，1 次插入） ======
  console.log("→ 生成运单快照（20 条，批量插入）…");
  const skuCodes = ["SKU-001", "SKU-002", "SKU-003", "SKU-004", "SKU-005", "SKU-006", "SKU-007", "SKU-008"];
  const skuNames = ["无线蓝牙耳机", "便携充电宝", "机械键盘", "高清摄像头", "智能手环", "USB-C扩展坞", "电竞鼠标", "降噪耳机"];

  const snapshotData: Array<typeof waybillSnapshots.$inferInsert> = [];
  const skuSnapshotData: Array<typeof waybillSkuSnapshots.$inferInsert> = [];
  const snapshotMeta: Array<{ id: string; v2ShipmentId: string; batchId: string; skuCode: string; skuName: string; skuSpec: string }> = [];

  for (let i = 0; i < 20; i++) {
    const snapId = crypto.randomUUID();
    const externalCode = `DEMO-${String(i + 1).padStart(4, "0")}`;
    const skuCode = skuCodes[i % skuCodes.length];
    const skuName = skuNames[i % skuNames.length];
    const qty = randomInt(5, 50);
    const batchId = `BATCH-${String(randomInt(1, 10)).padStart(3, "0")}`;

    snapshotData.push({
      id: snapId,
      v2ShipmentId: `demo-v2-${i + 1}`,
      externalCode,
      storeName: `演示门店${randomInt(1, 10)}`,
      receiverName: `收件人${i + 1}`,
      receiverPhoneMasked: `138****${String(randomInt(1000, 9999))}`,
      receiverAddressSummary: `演示地址-${randomInt(1, 50)}号`,
      skuCount: 1,
      totalQuantity: String(qty),
      amount: "0",
      batchId,
      rawPayload: { externalCode, demo: true },
      sourceSyncedAt: new Date(Date.now() - randomInt(1, 30) * 86400000),
      sourceVersion: "v1",
    });

    skuSnapshotData.push({
      waybillSnapshotId: snapId,
      v2OrderId: `demo-order-${i + 1}`,
      skuCode,
      skuName,
      skuQuantity: String(qty),
      skuSpec: `规格-${String.fromCharCode(65 + (i % 5))}`,
      rawPayload: { skuCode, skuName, demo: true },
      sourceSyncedAt: new Date(),
    });

    snapshotMeta.push({ id: snapId, v2ShipmentId: `demo-v2-${i + 1}`, batchId, skuCode, skuName, skuSpec: `规格-${String.fromCharCode(65 + (i % 5))}` });
  }

  await db.insert(waybillSnapshots).values(snapshotData);
  await db.insert(waybillSkuSnapshots).values(skuSnapshotData);

  // ====== 批量生成 200 条工单（先在内存构造，再分批插入） ======
  console.log("→ 生成 200 条工单（内存构造，批量插入）…");

  const ticketsData: Array<typeof exceptionTickets.$inferInsert> = [];
  const approvalsData: Array<typeof approvalRecords.$inferInsert> = [];
  const compensationsData: Array<typeof compensationRecords.$inferInsert> = [];
  const movementsData: Array<typeof inventoryMovements.$inferInsert> = [];
  const scansData: Array<typeof scanRecords.$inferInsert> = [];

  for (let i = 0; i < 200; i++) {
    const isQc = Math.random() < 0.3;
    const meta = snapshotMeta[i % snapshotMeta.length];
    const category = isQc ? "quality_control" : "logistics";
    const source = isQc ? "scan_qc" : "manual_report";
    const subtype = isQc ? randomChoice(QC_SUBTYPES) : randomChoice(LOGISTICS_SUBTYPES);
    const severity = randomChoice(SEVERITIES);
    const status = randomChoice(STATUSES);
    const amount = isQc ? 0 : randomInt(100, 5000);
    const reporter = isQc ? warehouseOp : operator;
    const ticketId = crypto.randomUUID();
    const ticketNo = `TKT-${String(i + 1).padStart(5, "0")}`;
    const now = new Date(Date.now() - randomInt(1, 60) * 3600000);
    const level = severity === "high" || amount > 100 ? 2 : 1;

    ticketsData.push({
      id: ticketId,
      ticketNo,
      waybillSnapshotId: meta.id,
      v2ShipmentId: meta.v2ShipmentId,
      source,
      category,
      subtype,
      severity,
      estimatedAmount: String(amount),
      description: `演示${isQc ? "品控" : "物流"}异常：${subtype}，${severity}严重度`,
      status,
      currentLevel: status === "level1_reviewing" ? 1 : status === "level2_reviewing" ? 2 : 0,
      reporterId: reporter.id,
      resubmitCount: status === "closed_rejected_limit" ? 2 : randomInt(0, 1),
      version: randomInt(1, 5),
      dueAt: ["level1_reviewing", "level2_reviewing"].includes(status) ? new Date(Date.now() + randomInt(-10, 20) * 3600000) : null,
      lastActionAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // 审批记录
    if (["completed", "executing", "rejected", "auto_rejected_timeout", "closed_rejected_limit"].includes(status)) {
      const approver = level === 2 ? level2 : level1;
      const approvalId = crypto.randomUUID();
      const action = status === "rejected" ? "reject" : status === "auto_rejected_timeout" ? "auto_reject" : status === "closed_rejected_limit" ? "reject" : "approve";

      approvalsData.push({
        id: approvalId,
        ticketId,
        approverId: approver.id,
        level,
        action,
        comment: action === "approve" ? "同意处理" : action === "reject" ? "驳回，需补充信息" : "超时自动驳回",
        fromStatus: level === 2 ? "level2_reviewing" : "level1_reviewing",
        toStatus: status === "rejected" ? "rejected" : status === "auto_rejected_timeout" ? "auto_rejected_timeout" : "executing",
        createdAt: new Date(now.getTime() + 3600000),
      });

      // 物流完成态：赔付 + 库存流水
      if (status === "completed" && !isQc) {
        compensationsData.push({
          ticketId,
          approvalRecordId: approvalId,
          direction: "pay_customer",
          amount: String(amount > 0 ? amount : randomInt(200, 3000)),
          status: "recorded",
          counterpartyName: `客户${i + 1}`,
          reason: "物流异常理赔",
        });

        const mvType = Math.random() < 0.5 ? "outbound" : "return_in";
        movementsData.push({
          ticketId,
          approvalRecordId: approvalId,
          skuCode: meta.skuCode,
          batchNo: meta.batchId,
          movementType: mvType,
          quantity: String(randomInt(1, 10)),
          beforeSnapshot: { available: 100, locked: 0 },
          afterSnapshot: { available: mvType === "outbound" ? 90 : 110, locked: 0 },
        });
      }

      // 品控完成态：追偿 + 库存流水
      if (status === "completed" && isQc) {
        compensationsData.push({
          ticketId,
          approvalRecordId: approvalId,
          direction: "recover_supplier",
          amount: String(randomInt(500, 5000)),
          status: "recorded",
          counterpartyName: "供应商A",
          reason: "品控异常追偿",
        });

        movementsData.push({
          ticketId,
          approvalRecordId: approvalId,
          skuCode: meta.skuCode,
          batchNo: meta.batchId,
          movementType: "unlock",
          quantity: String(randomInt(1, 10)),
          beforeSnapshot: { available: 100, locked: 10 },
          afterSnapshot: { available: 100, locked: 0 },
        });
      }
    }

    // 品控工单扫描记录
    if (isQc) {
      scansData.push({
        scanNo: `SCAN-DEMO-${String(i + 1).padStart(5, "0")}`,
        waybillSnapshotId: meta.id,
        v2ShipmentId: meta.v2ShipmentId,
        skuCode: meta.skuCode,
        skuName: meta.skuName,
        skuSpec: meta.skuSpec,
        expectedQuantity: String(randomInt(10, 50)),
        actualQuantity: String(randomInt(5, 45)),
        batchNo: meta.batchId,
        operatorId: warehouseOp.id,
        deviceId: "PDA-DEMO",
        qcResult: "abnormal",
        qcStatus: status === "completed" ? "released" : "qc_hold",
        matchedRuleId: null,
        decisionBasis: { demo: true, subtype },
        ticketId,
        description: `演示扫描异常：${subtype}`,
        holdDueAt: new Date(Date.now() + 2 * 3600000),
      });
    }
  }

  // 批量插入（每批最多 100 条，避免单次 SQL 过长）
  const BATCH = 100;
  for (let i = 0; i < ticketsData.length; i += BATCH) {
    await db.insert(exceptionTickets).values(ticketsData.slice(i, i + BATCH));
  }
  for (let i = 0; i < approvalsData.length; i += BATCH) {
    await db.insert(approvalRecords).values(approvalsData.slice(i, i + BATCH));
  }
  if (compensationsData.length > 0) {
    await db.insert(compensationRecords).values(compensationsData);
  }
  if (movementsData.length > 0) {
    await db.insert(inventoryMovements).values(movementsData);
  }
  if (scansData.length > 0) {
    await db.insert(scanRecords).values(scansData);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n✅ 演示数据生成完成（耗时 ${elapsed}s）：`);
  console.log(`  工单 ${ticketsData.length} 条`);
  console.log(`  审批记录 ${approvalsData.length} 条`);
  console.log(`  赔付记录 ${compensationsData.length} 条`);
  console.log(`  库存流水 ${movementsData.length} 条`);
  console.log(`  扫描记录 ${scansData.length} 条`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("演示数据生成失败:", err);
    process.exit(1);
  });
