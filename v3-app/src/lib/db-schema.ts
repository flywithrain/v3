import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ====== §8.1 users：模拟用户表 ======
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  roleCodes: text("role_codes").notNull(), // 逗号分隔，例 "level1_approver,operator"
  tenantId: varchar("tenant_id", { length: 50 }).default("default"),
  warehouseId: varchar("warehouse_id", { length: 50 }),
  enabled: boolean("enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ====== §8.2 waybill_snapshots：V3 运单本地快照 ======
export const waybillSnapshots = pgTable(
  "waybill_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    v2ShipmentId: varchar("v2_shipment_id", { length: 100 }).notNull(),
    externalCode: varchar("external_code", { length: 255 }),
    storeName: varchar("store_name", { length: 255 }),
    receiverName: varchar("receiver_name", { length: 255 }),
    receiverPhoneMasked: varchar("receiver_phone_masked", { length: 50 }),
    receiverAddressSummary: text("receiver_address_summary"),
    remark: text("remark"),
    skuCount: integer("sku_count").default(0),
    totalQuantity: numeric("total_quantity").default("0"),
    amount: numeric("amount").default("0"), // V2 无金额，按数量估算或默认 0
    batchId: varchar("batch_id", { length: 100 }),
    rawPayload: jsonb("raw_payload"),
    sourceSyncedAt: timestamp("source_synced_at").notNull(),
    sourceVersion: varchar("source_version", { length: 50 }).default("v1"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    uniqueIndex("waybill_snapshots_v2_shipment_id_uq").on(t.v2ShipmentId),
    uniqueIndex("waybill_snapshots_external_code_uq").on(t.externalCode),
  ]
);

// ====== §8.3 waybill_sku_snapshots：V2 SKU 明细快照 ======
export const waybillSkuSnapshots = pgTable("waybill_sku_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  waybillSnapshotId: uuid("waybill_snapshot_id")
    .notNull()
    .references(() => waybillSnapshots.id, { onDelete: "cascade" }),
  v2OrderId: varchar("v2_order_id", { length: 100 }),
  skuCode: varchar("sku_code", { length: 100 }).notNull(),
  skuName: varchar("sku_name", { length: 500 }).notNull(),
  skuQuantity: numeric("sku_quantity").notNull(),
  skuSpec: varchar("sku_spec", { length: 500 }),
  rawPayload: jsonb("raw_payload"),
  sourceSyncedAt: timestamp("source_synced_at").notNull(),
});

// ====== §8.4 integration_logs：跨系统接口日志 ======
export const integrationLogs = pgTable(
  "integration_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    direction: varchar("direction", { length: 20 }).notNull(), // v3_to_v2 / v2_to_v3
    endpoint: varchar("endpoint", { length: 255 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    requestSummary: jsonb("request_summary"),
    statusCode: integer("status_code"),
    success: boolean("success").notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorCode: varchar("error_code", { length: 50 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("integration_logs_request_id_idx").on(t.requestId), index("integration_logs_created_at_idx").on(t.createdAt)]
);

// ====== §8.5 exception_tickets：异常工单主表 ======
export const exceptionTickets = pgTable(
  "exception_tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketNo: varchar("ticket_no", { length: 50 }).notNull(),
    waybillSnapshotId: uuid("waybill_snapshot_id").references(() => waybillSnapshots.id),
    v2ShipmentId: varchar("v2_shipment_id", { length: 100 }),
    source: varchar("source", { length: 30 }).notNull(), // manual_report / scan_qc
    category: varchar("category", { length: 30 }).notNull(), // logistics / quality_control
    subtype: varchar("subtype", { length: 50 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull(), // low/medium/high
    estimatedAmount: numeric("estimated_amount").default("0"),
    description: text("description").notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    currentLevel: integer("current_level").default(0), // 0/1/2
    reporterId: uuid("reporter_id").references(() => users.id),
    assignedApproverId: uuid("assigned_approver_id"),
    resubmitCount: integer("resubmit_count").default(0),
    version: integer("version").default(1), // 乐观锁
    dueAt: timestamp("due_at"),
    lastActionAt: timestamp("last_action_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    uniqueIndex("exception_tickets_ticket_no_uq").on(t.ticketNo),
    index("exception_tickets_status_idx").on(t.status),
    index("exception_tickets_shipment_subtype_idx").on(t.v2ShipmentId, t.subtype, t.status),
    index("exception_tickets_due_at_idx").on(t.dueAt),
  ]
);

// ====== §8.6 approval_records：审批记录 ======
export const approvalRecords = pgTable(
  "approval_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => exceptionTickets.id, { onDelete: "cascade" }),
    approverId: uuid("approver_id").references(() => users.id),
    level: integer("level"), // 1/2
    action: varchar("action", { length: 30 }).notNull(), // approve/reject/auto_escalate/auto_reject/transfer
    comment: text("comment"),
    fromStatus: varchar("from_status", { length: 40 }),
    toStatus: varchar("to_status", { length: 40 }),
    idempotencyKey: varchar("idempotency_key", { length: 80 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_records_idempotency_key_uq").on(t.idempotencyKey),
    index("approval_records_ticket_id_idx").on(t.ticketId),
  ]
);

// ====== §8.9 approval_rules：审批规则表 ======
export const approvalRules = pgTable("approval_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  category: varchar("category", { length: 30 }).notNull(), // logistics / quality_control / all
  conditionConfig: jsonb("condition_config").notNull(), // { amountLte?, amountGt?, severity? }
  targetLevel: integer("target_level").notNull(), // 1/2
  timeoutHours: integer("timeout_hours"),
  enabled: boolean("enabled").default(true),
  priority: integer("priority").default(100),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ====== §8.10 compensation_records：赔付/追偿记录 ======
export const compensationRecords = pgTable(
  "compensation_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => exceptionTickets.id, { onDelete: "cascade" }),
    approvalRecordId: uuid("approval_record_id").references(() => approvalRecords.id),
    direction: varchar("direction", { length: 30 }).notNull(), // pay_customer / recover_supplier
    amount: numeric("amount").notNull(),
    status: varchar("status", { length: 20 }).default("recorded"), // pending/recorded/reconciled/cancelled
    counterpartyName: varchar("counterparty_name", { length: 255 }),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("compensation_records_ticket_id_idx").on(t.ticketId), index("compensation_records_approval_record_id_idx").on(t.approvalRecordId)]
);

// ====== §8.11 inventory_items：库存表 ======
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skuCode: varchar("sku_code", { length: 100 }).notNull(),
    skuName: varchar("sku_name", { length: 500 }),
    batchNo: varchar("batch_no", { length: 100 }).notNull(),
    availableQuantity: numeric("available_quantity").default("0"),
    lockedQuantity: numeric("locked_quantity").default("0"),
    status: varchar("status", { length: 20 }).default("normal"), // normal/locked/returned/scrapped
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [uniqueIndex("inventory_items_sku_batch_uq").on(t.skuCode, t.batchNo)]
);

// ====== §8.12 inventory_movements：库存流水 ======
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id").references(() => exceptionTickets.id),
    approvalRecordId: uuid("approval_record_id").references(() => approvalRecords.id),
    skuCode: varchar("sku_code", { length: 100 }).notNull(),
    batchNo: varchar("batch_no", { length: 100 }).notNull(),
    movementType: varchar("movement_type", { length: 30 }).notNull(), // lock/unlock/outbound/return_in/scrap/repurchase
    quantity: numeric("quantity").notNull(),
    beforeSnapshot: jsonb("before_snapshot"),
    afterSnapshot: jsonb("after_snapshot"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("inventory_movements_ticket_id_idx").on(t.ticketId),
    index("inventory_movements_approval_record_id_idx").on(t.approvalRecordId),
    index("inventory_movements_sku_batch_idx").on(t.skuCode, t.batchNo),
  ]
);

// ====== §8.13 audit_logs：审计日志 ======
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id").references(() => users.id),
    targetType: varchar("target_type", { length: 30 }).notNull(), // ticket/rule/inventory/integration
    targetId: varchar("target_id", { length: 100 }),
    action: varchar("action", { length: 50 }).notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("audit_logs_target_idx").on(t.targetType, t.targetId), index("audit_logs_actor_id_idx").on(t.actorId)]
);

// ====== 后续轮次将补充（本轮 schema 占位，不参与建表） ======
// §8.7 scan_records：扫描记录（扫描品控闭环，后续轮次）
// §8.8 qc_rules：品控规则表（扫描品控闭环，后续轮次）
