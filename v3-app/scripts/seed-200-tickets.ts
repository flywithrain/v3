/**
 * V3 演示数据种子：生成 200+ 条异常工单，覆盖各种状态、类型、审批层级。
 * 用途：npm run seed:demo
 *
 * 注意：这些工单直接写入本地数据库用于演示，关联合成运单快照。
 * 实际上报流程仍走 V2 API 实时校验。
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
  inventoryItems,
  scanRecords,
  auditLogs,
} from "../src/lib/db-schema";
import { eq } from "drizzle-orm";

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
  const qcSup = allUsers.find((u) => u.roleCodes.includes("qc_supervisor")) ?? allUsers[0];

  console.log("→ 清空旧工单数据…");
  await db.delete(auditLogs);
  await db.delete(inventoryMovements);
  await db.delete(compensationRecords);
  await db.delete(scanRecords);
  await db.delete(approvalRecords);
  await db.delete(exceptionTickets);
  await db.delete(waybillSkuSnapshots);
  await db.delete(waybillSnapshots);

  console.log("→ 生成运单快照（20 条）…");
  const snapshotIds: string[] = [];
  const skuCodes = ["SKU-001", "SKU-002", "SKU-003", "SKU-004", "SKU-005", "SKU-006", "SKU-007", "SKU-008"];
  const skuNames = ["无线蓝牙耳机", "便携充电宝", "机械键盘", "高清摄像头", "智能手环", "USB-C扩展坞", "电竞鼠标", "降噪耳机"];

  for (let i = 0; i < 20; i++) {
    const snapId = crypto.randomUUID();
    const externalCode = `DEMO-${String(i + 1).padStart(4, "0")}`;
    const skuCode = skuCodes[i % skuCodes.length];
    const skuName = skuNames[i % skuNames.length];
    const qty = randomInt(5, 50);

    await db.insert(waybillSnapshots).values({
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
      batchId: `BATCH-${String(randomInt(1, 10)).padStart(3, "0")}`,
      rawPayload: { externalCode, demo: true },
      sourceSyncedAt: new Date(Date.now() - randomInt(1, 30) * 86400000),
      sourceVersion: "v1",
    });

    await db.insert(waybillSkuSnapshots).values({
      waybillSnapshotId: snapId,
      v2OrderId: `demo-order-${i + 1}`,
      skuCode,
      skuName,
      skuQuantity: String(qty),
      skuSpec: `规格-${String.fromCharCode(65 + (i % 5))}`,
      rawPayload: { skuCode, skuName, demo: true },
      sourceSyncedAt: new Date(),
    });

    snapshotIds.push(snapId);
  }

  console.log("→ 生成 200 条工单…");
  let ticketCount = 0;
  let approvalCount = 0;
  let compensationCount = 0;
  let movementCount = 0;
  let scanCount = 0;

  for (let i = 0; i < 200; i++) {
    const isQc = Math.random() < 0.3; // 30% 品控工单
    const snapId = snapshotIds[i % snapshotIds.length];
    const [snap] = await db.select().from(waybillSnapshots).where(eq(waybillSnapshots.id, snapId)).limit(1);
    const [sku] = await db.select().from(waybillSkuSnapshots).where(eq(waybillSkuSnapshots.waybillSnapshotId, snapId)).limit(1);

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
    const level = severity === "high" || amount > 1000 ? 2 : 1;

    await db.insert(exceptionTickets).values({
      id: ticketId,
      ticketNo,
      waybillSnapshotId: snapId,
      v2ShipmentId: snap?.v2ShipmentId ?? `demo-v2-${(i % 20) + 1}`,
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
    ticketCount++;

    // 生成审批记录
    if (["completed", "executing", "rejected", "auto_rejected_timeout", "closed_rejected_limit"].includes(status)) {
      const approver = level === 2 ? level2 : level1;
      const approvalId = crypto.randomUUID();
      const action = status === "rejected" ? "reject" : status === "auto_rejected_timeout" ? "auto_reject" : status === "closed_rejected_limit" ? "reject" : "approve";

      await db.insert(approvalRecords).values({
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
      approvalCount++;

      // 完成态：生成赔付和库存流水
      if (status === "completed" && !isQc) {
        const compAmount = amount > 0 ? amount : randomInt(200, 3000);
        await db.insert(compensationRecords).values({
          ticketId,
          approvalRecordId: approvalId,
          direction: "pay_customer",
          amount: String(compAmount),
          status: "recorded",
          counterpartyName: `客户${i + 1}`,
          reason: "物流异常理赔",
        });
        compensationCount++;

        if (sku) {
          const mvType = Math.random() < 0.5 ? "outbound" : "return_in";
          await db.insert(inventoryMovements).values({
            ticketId,
            approvalRecordId: approvalId,
            skuCode: sku.skuCode,
            batchNo: snap?.batchId ?? "BATCH-001",
            movementType: mvType,
            quantity: String(randomInt(1, 10)),
            beforeSnapshot: { available: 100, locked: 0 },
            afterSnapshot: { available: mvType === "outbound" ? 90 : 110, locked: 0 },
          });
          movementCount++;
        }
      }

      // 品控完成态：生成追偿记录
      if (status === "completed" && isQc) {
        const compAmount = randomInt(500, 5000);
        await db.insert(compensationRecords).values({
          ticketId,
          approvalRecordId: approvalId,
          direction: "recover_supplier",
          amount: String(compAmount),
          status: "recorded",
          counterpartyName: "供应商A",
          reason: "品控异常追偿",
        });
        compensationCount++;

        if (sku) {
          await db.insert(inventoryMovements).values({
            ticketId,
            approvalRecordId: approvalId,
            skuCode: sku.skuCode,
            batchNo: snap?.batchId ?? "BATCH-001",
            movementType: "unlock",
            quantity: String(randomInt(1, 10)),
            beforeSnapshot: { available: 100, locked: 10 },
            afterSnapshot: { available: 100, locked: 0 },
          });
          movementCount++;
        }
      }
    }

    // 品控工单生成扫描记录
    if (isQc) {
      const scanId = crypto.randomUUID();
      await db.insert(scanRecords).values({
        scanNo: `SCAN-DEMO-${String(i + 1).padStart(5, "0")}`,
        waybillSnapshotId: snapId,
        v2ShipmentId: snap?.v2ShipmentId ?? `demo-v2-${(i % 20) + 1}`,
        skuCode: sku?.skuCode ?? "SKU-001",
        skuName: sku?.skuName ?? "商品",
        skuSpec: sku?.skuSpec ?? null,
        expectedQuantity: String(randomInt(10, 50)),
        actualQuantity: String(randomInt(5, 45)),
        batchNo: snap?.batchId ?? "BATCH-001",
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
      scanCount++;
    }
  }

  console.log(`\n✅ 演示数据生成完成：`);
  console.log(`  工单 ${ticketCount} 条`);
  console.log(`  审批记录 ${approvalCount} 条`);
  console.log(`  赔付记录 ${compensationCount} 条`);
  console.log(`  库存流水 ${movementCount} 条`);
  console.log(`  扫描记录 ${scanCount} 条`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("演示数据生成失败:", err);
    process.exit(1);
  });
