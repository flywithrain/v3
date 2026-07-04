# 运单全流程管理系统 V3 研发需求文档

本文档供研发 agent 直接开发使用。考试原文见同目录 `exam-v3-exception-waybill-approval-改进版.md`，本文档在考试要求基础上补齐可执行的产品范围、业务假设、数据模型、接口契约、页面/API 清单、验收标准和实施顺序。

## 1. 项目目标

建设一个独立于 V2 的 V3 运单全生命周期管理系统，覆盖：

1. 从 V2 通过 HTTP API 获取真实运单与 SKU 明细。
2. 仓库扫描录入并触发品控规则检测。
3. 品控异常自动暂扣批次并创建工单。
4. 物流异常人工上报并创建工单。
5. 异常工单分级审批、拒绝重提、超时流转、并发冲突保护。
6. 审批通过后联动赔付、库存、退仓、重发、重采购等动作。
7. 提供跨系统接口调用日志和同步监控。
8. 随项目提交《需求理解与假设说明》和系统间接口文档。

V3 必须是独立部署、独立数据库、独立代码项目。V3 不允许直接连接 V2 数据库，不允许用静态 JSON 假装 V2 接口返回。

## 2. 已知 V2 项目上下文

V2 项目路径：`D:\project\local\history\20260704\v2`

已确认技术栈：

- Next.js App Router + TypeScript。
- Drizzle ORM。
- Neon/PostgreSQL。
- Tailwind CSS v4。
- 视觉风格主色 `#0fc6c2`，页面背景 `#f7f8fa`，卡片白底、浅阴影、圆角，表格表头浅青色。
- 图标使用 `lucide-react`。

V2 关键数据表：

- `parse_rules`：解析规则表，核心配置存储在 `config jsonb`。
- `shipments`：运单/出库单主表，字段包括 `id`、`externalCode`、`storeName`、`receiverName`、`receiverPhone`、`receiverAddress`、`remark`、`skuCount`、`totalQuantity`、`batchId`、`submittedAt`。
- `orders`：SKU 明细表，字段包括 `id`、`shipmentId`、`skuCode`、`skuName`、`skuQuantity`、`skuSpec`、`remark`。

V2 当前主要能力：

- 文件上传解析。
- 解析规则管理。
- 解析结果预览和提交。
- 已导入运单列表和 SKU 明细查看。

V3 对 V2 的依赖方式：

- 必须通过 HTTP API 调用 V2。
- 如 V2 当前没有满足要求的对外接口，允许以兼容方式给 V2 新增 `/api/v1/*` 只读接口和可选回写接口。
- V2 新增接口不得破坏现有页面、Server Actions、数据库结构和已有调用方。

## 3. 硬性约束

1. V3 与 V2 是两个独立系统，不能共享同一套数据库连接。
2. V3 使用自己的数据库实例或自己的独立库。
3. V3 的运单数据只保存快照/缓存，不把 V2 运单主数据当成本系统主数据修改。
4. 发起异常上报、扫描校验 SKU 归属时，必须实时调用 V2 API。
5. 所有跨系统调用必须记录 Request ID、接口名、入参摘要、状态码、耗时、错误信息。
6. 工单状态变更与本地库存/赔付联动必须保持一致，优先使用数据库事务。
7. 审批接口必须做后端权限校验，不能只靠前端隐藏按钮。
8. 品控扫描批次状态机与异常工单状态机必须分离，通过 `ticket_id` 关联。
9. 同一批次同一 SKU 已存在未关闭品控工单时，重复扫描只追加扫描记录，不重复创建工单。
10. 误判快速放行仅品控主管可操作，必须填写原因并留痕。
11. 审批人不能审批自己上报的工单。
12. AI 只可作为建议，不得自动执行关键动作；AI 失败不得阻塞主流程。

## 4. 推荐技术方案

沿用 V2 技术栈，但创建独立 V3 项目：

- Next.js App Router + TypeScript。
- Drizzle ORM + PostgreSQL/Neon。
- Tailwind CSS v4。
- `lucide-react` 图标。
- 使用 Vercel 部署。

建议项目结构：

```text
v3-app/
  src/app/
    page.tsx
    scan/page.tsx
    tickets/page.tsx
    tickets/new/page.tsx
    tickets/[id]/page.tsx
    approvals/page.tsx
    rules/approval/page.tsx
    rules/qc/page.tsx
    integrations/page.tsx
    inventory/page.tsx
    api/
      scan/route.ts
      tickets/route.ts
      tickets/[id]/route.ts
      tickets/[id]/approve/route.ts
      tickets/[id]/resubmit/route.ts
      tickets/[id]/quick-release/route.ts
      rules/approval/route.ts
      rules/qc/route.ts
      integrations/logs/route.ts
      jobs/timeout/route.ts
  src/lib/
    db.ts
    db-schema.ts
    v2-client.ts
    state-machine.ts
    approval-engine.ts
    qc-engine.ts
    execution-engine.ts
    auth.ts
    idempotency.ts
  src/types/
    index.ts
  scripts/
    seed.ts
    seed-200-tickets.ts
  docs/
    system-integration-api.md
    requirements-assumptions.md
```

## 5. 角色与权限

实现一个轻量角色模型即可，可用模拟登录/角色切换，不强制接真实企业 SSO。

角色：

| 角色 | 权限 |
|---|---|
| `operator` 操作员 | 手工上报物流异常；查看自己权限范围内工单；不能审批自己提交的工单 |
| `warehouse_operator` 仓库操作员 | 扫描录入；查看扫描记录；不能快速放行 |
| `qc_supervisor` 品控主管 | 查看品控工单；执行误判快速放行；可作为一级审批人，但不能审批自己发起或自己快速放行过的工单 |
| `level1_approver` 一级审批人 | 处理一级审批；不能处理二级审批；不能审批自己提交的工单 |
| `level2_approver` 二级审批人 | 处理二级审批和强制升级工单；不能审批自己提交的工单 |
| `admin` 管理员 | 规则配置、角色配置、兜底转交、接口监控、数据种子 |
| `auditor` 审计查看 | 只读查看工单、审批记录、库存和赔付记录 |

权限要求：

- 前端按钮根据角色隐藏或置灰。
- 后端 API 必须再次校验角色、工单状态、审批层级和提交人。
- 无权限时返回明确错误码和中文提示。
- 同一个用户可拥有多个角色，但自批自核规则始终生效。

## 6. 业务假设与默认配置

以下默认值必须放入可配置表，不能硬编码在业务逻辑中。

### 6.1 分级审批金额阈值

| 规则 | 默认值 |
|---|---|
| 物流异常预计损失金额 `<= 1000` 元 | 一级审批通过后可执行 |
| 物流异常预计损失金额 `> 1000` 元 | 必须进入二级审批 |
| 任意异常严重度为 `high` | 必须进入二级审批 |
| 品控异常自动创建工单 | 默认直接进入二级审批，因涉及批次锁定和供应商追偿 |

理由：低金额理赔应快速处理，高金额和高严重度需加强控制；品控异常发生在出库前，压仓和后续追偿风险更集中。

### 6.2 超时时长

| 项 | 默认值 | 超时动作 |
|---|---:|---|
| 待审批未分派 | 4 小时 | 自动进入一级审批队列，若无可用审批人则升级二级审批 |
| 一级审批中 | 8 小时 | 自动升级二级审批 |
| 二级审批中 | 24 小时 | 自动驳回并标记为 `auto_rejected_timeout`，管理员可重新打开 |
| 品控暂扣 | 2 小时 | 强制升级二级审批 |

品控暂扣超时独立且短于审批超时，因为批次锁定会直接造成库存占用和履约延迟。

### 6.3 重提次数上限

- 拒绝后最多允许重新提交 2 次。
- 第 3 次被拒绝后自动关闭，状态为 `closed_rejected_limit`。
- 管理员可基于审计原因重新打开，但必须产生审计日志。

### 6.4 物流异常到下游动作映射

| 异常类型 | 默认动作 | 是否赔付客户 | 是否库存联动 |
|---|---|---:|---:|
| 丢件 | 客户理赔 + 重新发货 | 是 | 重新发货扣减库存 |
| 破损 | 客户理赔 + 退货入库/重新发货 | 是 | 退货入库增加可疑库存，重新发货扣减库存 |
| 客户拒收 | 退货入库 | 否，除非人工选择补偿 | 退货入库 |
| 超时未签收 | 补偿券/部分理赔或继续跟进 | 可选 | 默认不联动库存 |
| 收货地址错误 | 修改地址后重新发货 | 否 | 重新发货扣减库存 |

### 6.5 品控规则触发阈值

| 品控子类型 | 默认判定规则 | 默认严重度 |
|---|---|---|
| 数量不符 | 实扫数量与 V2 SKU 数量不一致，或差异率 `>= 5%` | medium |
| 外观破损 | 破损等级 `>= 2` 触发；等级 `>= 4` 直接 high | medium/high |
| 规格不符 | 实扫规格与 V2 SKU 规格不一致 | high |
| 标签错误 | 标签 SKU 与运单 SKU 不一致 | high |
| 批次异常 | 批次号命中召回/禁售/过期规则 | high |

规则必须可配置，规则执行结果需记录命中的 `qc_rule_id` 和判定依据。

### 6.6 V2 同步策略

- 发起异常上报时：实时调用 V2 `GET /api/v1/shipments/{id or externalCode}` 校验并刷新本地快照。
- 扫描录入时：实时调用 V2 SKU 归属校验接口。
- 列表/详情展示：优先展示本地快照，同时详情页提供“刷新 V2 最新数据”按钮。
- 定时同步：每 15 分钟增量同步一次最近 7 天有变更的运单快照。
- V2 不可用：允许只读展示本地缓存，并在页面标注“使用本地缓存，同步于 YYYY-MM-DD HH:mm:ss，数据可能非最新”；禁止创建新异常和扫描通过动作，直到关键实时校验恢复。

## 7. 核心状态机

### 7.1 工单状态

建议枚举：

| 状态 | 含义 |
|---|---|
| `draft` | 草稿，仅可编辑 |
| `pending_review` | 待审批 |
| `level1_reviewing` | 一级审批中 |
| `level2_reviewing` | 二级审批中 |
| `rejected` | 已拒绝，允许重提 |
| `executing` | 审批通过，执行联动中 |
| `completed` | 已完成 |
| `closed` | 已关闭 |
| `auto_rejected_timeout` | 二级超时自动驳回 |
| `closed_rejected_limit` | 重提次数耗尽关闭 |

物流工单流转：

```text
pending_review -> level1_reviewing
level1_reviewing -> executing                  // 金额不超阈值且审批通过
level1_reviewing -> level2_reviewing            // 金额超阈值/高严重度/超时
level2_reviewing -> executing                   // 二级审批通过
level1_reviewing|level2_reviewing -> rejected   // 审批拒绝
rejected -> pending_review                      // 重提次数未超限
rejected -> closed_rejected_limit               // 重提次数超限
level2_reviewing -> auto_rejected_timeout       // 二级超时
executing -> completed
```

品控工单：

- 扫描异常自动创建后默认进入 `level2_reviewing`。
- 品控主管可走快速放行：`level2_reviewing -> completed`，但执行动作是 `quick_release`，必须同步解锁批次，并写入审计记录。

### 7.2 扫描批次状态

建议枚举：

| 状态 | 含义 |
|---|---|
| `scan_recorded` | 已扫描 |
| `qc_passed` | 品控通过，可出库 |
| `qc_hold` | 品控暂扣，批次锁定 |
| `escalated` | 暂扣超时，已强制升级二级审批 |
| `released` | 已放行并解锁 |
| `returned_supplier` | 已退供应商 |
| `repurchase_pending` | 已触发重采购 |
| `downgraded` | 已降级处理 |
| `closed` | 批次处理关闭 |

规则：

- `qc_hold` 期间同一 `batch_no + sku_code` 不得被其他运单引用。
- 工单未关闭前批次不得自动解锁。
- 执行动作和批次解锁必须在同一数据库事务内完成。

## 8. 数据库设计

字段名可按项目风格调整，但必须保留语义。

### 8.1 `users`

模拟用户表。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `name` | varchar | 必填 |
| `role_codes` | jsonb/text[] | 必填 |
| `tenant_id` | varchar | 可为空；单租户可固定为 `default` |
| `warehouse_id` | varchar | 可为空 |
| `enabled` | boolean | 默认 true |
| `created_at` | timestamp | 必填 |

### 8.2 `waybill_snapshots`

V3 运单本地快照。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `v2_shipment_id` | uuid/varchar | 必填，V2 `shipments.id` |
| `external_code` | varchar | V2 `shipments.externalCode` |
| `store_name` | varchar |  |
| `receiver_name` | varchar |  |
| `receiver_phone_masked` | varchar | 建议脱敏 |
| `receiver_address_summary` | text |  |
| `sku_count` | integer |  |
| `total_quantity` | numeric |  |
| `amount` | numeric | V2 无金额时可按数量估算或默认 0，并在假设文档说明 |
| `batch_id` | varchar | V2 `batchId` |
| `raw_payload` | jsonb | V2 原始响应快照 |
| `source_synced_at` | timestamp | 必填 |
| `source_version` | varchar | V2 接口版本 |
| `created_at` | timestamp |  |
| `updated_at` | timestamp |  |

唯一约束：

- `unique(v2_shipment_id)`
- `unique(external_code)`，允许空值时注意数据库差异。

### 8.3 `waybill_sku_snapshots`

V2 SKU 明细快照。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `waybill_snapshot_id` | uuid | FK |
| `v2_order_id` | uuid/varchar | V2 `orders.id` |
| `sku_code` | varchar | 必填 |
| `sku_name` | varchar | 必填 |
| `sku_quantity` | numeric | 必填 |
| `sku_spec` | varchar |  |
| `raw_payload` | jsonb |  |
| `source_synced_at` | timestamp | 必填 |

### 8.4 `integration_logs`

跨系统接口日志。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `request_id` | varchar | 必填，唯一 |
| `direction` | varchar | `v3_to_v2` / `v2_to_v3` |
| `endpoint` | varchar | 必填 |
| `method` | varchar | 必填 |
| `request_summary` | jsonb | 入参摘要，不存敏感明文 |
| `status_code` | integer | 可空 |
| `success` | boolean | 必填 |
| `duration_ms` | integer | 必填 |
| `error_code` | varchar | 可空 |
| `error_message` | text | 可空 |
| `created_at` | timestamp | 必填 |

### 8.5 `exception_tickets`

异常工单主表。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `ticket_no` | varchar | 唯一，人类可读 |
| `waybill_snapshot_id` | uuid | FK |
| `v2_shipment_id` | varchar | 冗余，用于查询 |
| `source` | varchar | `manual_report` / `scan_qc` |
| `category` | varchar | `logistics` / `quality_control` |
| `subtype` | varchar | 丢件、破损、数量不符等 |
| `severity` | varchar | `low` / `medium` / `high` |
| `estimated_amount` | numeric | 默认 0 |
| `description` | text | 必填 |
| `status` | varchar | 必填 |
| `current_level` | integer | 0/1/2 |
| `reporter_id` | uuid | FK users |
| `assigned_approver_id` | uuid | 可空 |
| `resubmit_count` | integer | 默认 0 |
| `version` | integer | 乐观锁，默认 1 |
| `due_at` | timestamp | 当前节点超时时间 |
| `last_action_at` | timestamp |  |
| `created_at` | timestamp |  |
| `updated_at` | timestamp |  |

唯一约束：

- 同一运单同一异常子类型未关闭时禁止重复上报：可用部分唯一索引或业务事务检查。

### 8.6 `approval_records`

审批记录表。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `ticket_id` | uuid | FK |
| `approver_id` | uuid | FK users |
| `level` | integer | 1/2 |
| `action` | varchar | `approve` / `reject` / `auto_escalate` / `auto_reject` / `transfer` |
| `comment` | text | 审批意见 |
| `from_status` | varchar | 必填 |
| `to_status` | varchar | 必填 |
| `idempotency_key` | varchar | 唯一，可空 |
| `created_at` | timestamp | 必填 |

### 8.7 `scan_records`

扫描记录表。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `scan_no` | varchar | 唯一 |
| `waybill_snapshot_id` | uuid | FK |
| `v2_shipment_id` | varchar | 必填 |
| `sku_code` | varchar | 必填 |
| `sku_name` | varchar | 可空 |
| `sku_spec` | varchar | 可空 |
| `expected_quantity` | numeric | V2 数量 |
| `actual_quantity` | numeric | 实扫数量 |
| `batch_no` | varchar | 必填 |
| `operator_id` | uuid | FK users |
| `device_id` | varchar | 可空 |
| `qc_result` | varchar | `passed` / `abnormal` |
| `qc_status` | varchar | 扫描批次状态 |
| `matched_rule_id` | uuid | FK qc_rules，可空 |
| `decision_basis` | jsonb | 判定依据 |
| `ticket_id` | uuid | FK exception_tickets，可空 |
| `hold_due_at` | timestamp | 品控暂扣超时时间 |
| `created_at` | timestamp |  |

索引：

- `index(batch_no, sku_code, qc_status)`
- `index(ticket_id)`

### 8.8 `qc_rules`

品控规则表。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `name` | varchar | 必填 |
| `subtype` | varchar | 必填 |
| `condition_type` | varchar | `quantity_diff` / `damage_level` / `spec_mismatch` / `label_mismatch` / `batch_risk` |
| `condition_config` | jsonb | 必填 |
| `severity` | varchar | 必填 |
| `auto_create_ticket` | boolean | 默认 true |
| `default_approval_level` | integer | 默认 2 |
| `enabled` | boolean | 默认 true |
| `created_at` | timestamp |  |
| `updated_at` | timestamp |  |

### 8.9 `approval_rules`

审批规则表。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `name` | varchar | 必填 |
| `category` | varchar | `logistics` / `quality_control` / `all` |
| `condition_config` | jsonb | 金额、严重度、类型等 |
| `target_level` | integer | 1/2 |
| `timeout_hours` | integer | 可空 |
| `enabled` | boolean | 默认 true |
| `priority` | integer | 数字越小优先级越高 |
| `created_at` | timestamp |  |
| `updated_at` | timestamp |  |

### 8.10 `compensation_records`

赔付/追偿记录。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `ticket_id` | uuid | FK |
| `approval_record_id` | uuid | FK |
| `direction` | varchar | `pay_customer` / `recover_supplier` |
| `amount` | numeric | 必填 |
| `status` | varchar | `pending` / `recorded` / `reconciled` / `cancelled` |
| `counterparty_name` | varchar | 客户或供应商 |
| `reason` | text |  |
| `created_at` | timestamp |  |

### 8.11 `inventory_items`

库存表，V3 自有简化库存。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `sku_code` | varchar | 必填 |
| `sku_name` | varchar |  |
| `batch_no` | varchar | 必填 |
| `available_quantity` | numeric | 默认 0 |
| `locked_quantity` | numeric | 默认 0 |
| `status` | varchar | `normal` / `locked` / `returned` / `scrapped` |
| `created_at` | timestamp |  |
| `updated_at` | timestamp |  |

唯一约束：

- `unique(sku_code, batch_no)`

### 8.12 `inventory_movements`

库存流水。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `ticket_id` | uuid | FK |
| `approval_record_id` | uuid | FK |
| `sku_code` | varchar | 必填 |
| `batch_no` | varchar | 必填 |
| `movement_type` | varchar | `lock` / `unlock` / `outbound` / `return_in` / `scrap` / `repurchase` |
| `quantity` | numeric | 必填 |
| `before_snapshot` | jsonb | 可空 |
| `after_snapshot` | jsonb | 可空 |
| `created_at` | timestamp |  |

### 8.13 `audit_logs`

审计日志，记录快速放行、规则修改、管理员转交等。

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | uuid | PK |
| `actor_id` | uuid | FK users |
| `target_type` | varchar | `ticket` / `rule` / `inventory` / `integration` |
| `target_id` | uuid/varchar | 必填 |
| `action` | varchar | 必填 |
| `detail` | jsonb | 必填 |
| `created_at` | timestamp |  |

## 9. V2 接口契约

若 V2 没有现成 API，研发 agent 需要在 V2 中新增以下接口。接口前缀统一使用 `/api/v1`，避免影响现有功能。

鉴权：

- V3 请求 V2 时带 `X-API-Key: <V2_API_KEY>`。
- 每次请求带 `X-Request-ID`。
- V2 返回体也带 `requestId`。

### 9.1 校验/获取运单详情

```http
GET /api/v1/shipments/lookup?shipmentId={id}
GET /api/v1/shipments/lookup?externalCode={externalCode}
```

返回：

```json
{
  "requestId": "req_xxx",
  "data": {
    "id": "uuid",
    "externalCode": "PS2512220005001",
    "storeName": "门店名",
    "receiverName": "张三",
    "receiverPhone": "138****0000",
    "receiverAddress": "地址",
    "skuCount": 3,
    "totalQuantity": "12",
    "batchId": "uuid",
    "submittedAt": "2026-07-04T00:00:00.000Z",
    "items": [
      {
        "id": "uuid",
        "skuCode": "SKU001",
        "skuName": "商品名",
        "skuQuantity": "2",
        "skuSpec": "规格",
        "remark": ""
      }
    ]
  }
}
```

错误：

- `404 WAYBILL_NOT_FOUND`
- `401 UNAUTHORIZED`
- `408 V2_TIMEOUT`

### 9.2 SKU 归属校验

```http
GET /api/v1/shipments/{shipmentId}/sku/validate?skuCode={skuCode}
```

返回：

```json
{
  "requestId": "req_xxx",
  "data": {
    "valid": true,
    "shipmentId": "uuid",
    "skuCode": "SKU001",
    "skuName": "商品名",
    "skuQuantity": "2",
    "skuSpec": "规格"
  }
}
```

### 9.3 运单增量同步

```http
GET /api/v1/shipments?updatedSince=2026-07-04T00:00:00.000Z&page=1&pageSize=100
```

返回分页数据。V2 当前如果没有 `updatedAt` 字段，可先按 `submittedAt` 近 7 天同步，并在接口文档中说明限制。

### 9.4 可选：异常标记回写

```http
POST /api/v1/shipments/{shipmentId}/exception-marker
```

用途：V3 有未关闭异常时通知 V2 显示提示。非必做，但做了可加分。

## 10. V3 API 清单

### 10.1 扫描

```http
POST /api/scan
```

入参：

```json
{
  "shipmentId": "v2-shipment-id",
  "skuCode": "SKU001",
  "actualQuantity": 1,
  "skuSpec": "规格",
  "batchNo": "BATCH-001",
  "deviceId": "PDA-01",
  "description": "外包装破损二级"
}
```

行为：

1. 调 V2 校验运单存在和 SKU 归属。
2. 刷新本地快照。
3. 执行品控规则。
4. 通过则写扫描记录，状态 `qc_passed`。
5. 异常则检查是否已有未关闭品控工单。
6. 已有工单：只追加扫描记录并返回已有 `ticketId`。
7. 无工单：事务内锁定库存、创建工单、写扫描记录、写审计日志。

### 10.2 创建人工物流异常

```http
POST /api/tickets
```

入参：

```json
{
  "shipmentId": "v2-shipment-id",
  "subtype": "lost",
  "severity": "medium",
  "estimatedAmount": 800,
  "description": "物流反馈包裹丢失"
}
```

行为：

1. 实时调用 V2 校验运单存在。
2. 刷新快照。
3. 检查同一运单同类型未关闭工单。
4. 根据审批规则决定进入一级或二级审批。
5. 创建工单并返回详情。

### 10.3 审批

```http
POST /api/tickets/{ticketId}/approve
POST /api/tickets/{ticketId}/reject
```

请求头：

- `Idempotency-Key`，前端每次操作生成。

入参：

```json
{
  "comment": "同意处理",
  "expectedVersion": 3,
  "executionAction": "pay_customer_and_reship"
}
```

要求：

- 使用 `expectedVersion` 做乐观锁。
- 使用 `Idempotency-Key` 防重复提交。
- 审批通过并进入执行动作时，事务内写审批记录、更新工单状态、生成赔付/库存流水。

### 10.4 快速放行

```http
POST /api/tickets/{ticketId}/quick-release
```

仅 `qc_supervisor` 可用。

入参：

```json
{
  "reason": "复核为扫描误判，实物规格与运单一致",
  "expectedVersion": 2
}
```

行为：

- 后端校验工单来源必须是 `scan_qc`。
- 工单必须未关闭。
- 事务内将工单置为 `completed`，扫描批次置为 `released`，解锁库存，写审计日志。

### 10.5 超时任务

```http
POST /api/jobs/timeout
```

用途：

- Vercel Cron 或手动触发。
- 扫描 `due_at` 和 `hold_due_at`。
- 一级超时升级二级。
- 二级超时自动驳回。
- 品控暂扣超时强制升级二级。

要求：

- 任务重复执行必须幂等。
- 自动流转也要写 `approval_records` 或 `audit_logs`。

## 11. 页面需求

### 11.1 首页 `/`

仪表盘：

- 待我审批数量。
- 品控暂扣数量。
- 今日新增异常。
- 即将超时工单。
- V2 接口最近同步状态。

### 11.2 扫描页 `/scan`

功能：

- 输入/选择 V2 运单 ID 或外部编码。
- 输入 SKU、实扫数量、规格、批次号、异常描述。
- 点击“扫描校验”。
- 展示 V2 校验结果、SKU 归属、规则命中情况。
- 异常时展示“已创建品控工单”或“已有未关闭品控工单，仅追加扫描记录”。
- 对品控主管展示“误判快速放行”入口。

交互：

- loading 状态。
- 成功/失败 toast。
- V2 不可用时明确提示，不允许继续创建新扫描异常。

### 11.3 人工上报页 `/tickets/new`

功能：

- 输入运单 ID 或外部编码。
- 实时查询 V2 并展示运单摘要和 SKU 明细。
- 选择物流异常类型。
- 输入预计金额、描述、严重度。
- 提交后进入对应审批状态。

### 11.4 工单列表 `/tickets`

筛选：

- 状态。
- 来源：手工上报/扫描触发。
- 异常大类：物流/品控。
- 异常子类型。
- 运单号/外部编码。
- 审批人。
- 是否即将超时。

列表列：

- 工单号。
- 来源。
- 运单外部编码。
- 异常类型。
- 严重度。
- 金额。
- 状态。
- 当前审批层级。
- 当前处理人。
- 截止时间。
- 数据来源标记。

必须分页，默认每页 20 条。

### 11.5 工单详情 `/tickets/[id]`

展示：

- 工单基础信息。
- 运单快照，并标注“实时获取自 V2”或“使用本地缓存，同步于 ...”。
- SKU 明细。
- 扫描记录，品控工单必展示。
- 审批历史时间线。
- 库存流水。
- 赔付记录。
- 审计日志。

操作：

- 审批通过/拒绝。
- 拒绝后重提。
- 品控主管快速放行。
- 管理员转交审批人。
- 刷新 V2 最新数据。

### 11.6 待审批页 `/approvals`

展示当前用户可处理的工单，不能展示无权审批的操作按钮。

### 11.7 规则配置页

`/rules/approval`：

- 配置金额阈值、严重度、目标审批层级、超时时长。

`/rules/qc`：

- 配置数量差异、破损等级、规格不符、标签错误、批次异常规则。
- 规则启停。
- 优先级。

### 11.8 接口监控 `/integrations`

展示：

- 最近一次 V2 同步时间。
- 同步成功率。
- 最近 50 条接口调用日志。
- 按 Request ID 查询。
- 错误分类：404、401、超时、5xx、网络错误。

### 11.9 库存页 `/inventory`

展示：

- SKU/批次库存。
- 可用数量。
- 锁定数量。
- 批次状态。
- 关联工单。
- 库存流水。

## 12. 执行联动规则

审批通过后执行动作由异常类型决定，允许审批人选择或系统默认。

### 12.1 物流异常动作

| 动作代码 | 说明 |
|---|---|
| `pay_customer` | 生成赔付记录，方向 `pay_customer` |
| `reship` | 生成重新发货库存出库流水 |
| `return_in` | 生成退货入库库存流水 |
| `pay_customer_and_reship` | 同时赔付客户并重新发货 |
| `address_correct_reship` | 地址更正后重新发货，不生成赔付 |

### 12.2 品控异常动作

| 动作代码 | 说明 |
|---|---|
| `release_goods` | 放行货物，解锁批次，不生成赔付 |
| `return_supplier_recover` | 退供应商，生成供应商追偿记录 |
| `repurchase_recover` | 批次作废，生成重采购任务/记录，生成追偿记录 |
| `downgrade_recover` | 降级处理，生成差价追偿记录 |
| `quick_release` | 品控主管误判快速放行 |

要求：

- 赔付记录必须有 `direction` 字段，物流是 `pay_customer`，品控是 `recover_supplier`。
- 库存流水和赔付记录必须关联 `approval_record_id`。
- 同一审批动作不得重复生成赔付或库存流水。

## 13. 并发、一致性与幂等

### 13.1 乐观锁

`exception_tickets.version` 每次状态变更递增。

审批提交时必须带 `expectedVersion`。若版本不一致，返回：

```json
{
  "code": "TICKET_VERSION_CONFLICT",
  "message": "该工单已被其他人处理，请刷新后查看最新状态"
}
```

### 13.2 幂等

审批、快速放行、超时任务都应支持幂等：

- 前端操作传 `Idempotency-Key`。
- `approval_records.idempotency_key` 唯一。
- 执行动作前检查当前状态和是否已存在对应赔付/库存流水。
- 定时任务按当前状态过滤，不对已处理工单重复操作。

### 13.3 事务

必须在同一数据库事务内完成：

- 审批记录写入。
- 工单状态更新。
- 本地库存流水写入。
- 本地赔付记录写入。
- 品控批次锁定/解锁状态更新。

跨 V2 的可选回写不要放在本地事务里阻塞主流程。可采用本地 outbox/重试日志记录，失败后在接口监控页提示。

## 14. 种子数据与演示

必须提供脚本：

```bash
npm run db:seed
npm run seed:demo
```

种子数据至少包含：

- 7 个模拟用户，覆盖所有角色。
- 5 条审批规则。
- 5 条品控规则。
- 20 条库存批次。
- 至少 200 条异常工单，覆盖：
  - 手工物流异常。
  - 扫描品控异常。
  - 各种状态。
  - 一级/二级审批。
  - 拒绝重提。
  - 超时。
  - 已完成联动赔付/库存记录。

注意：演示工单必须关联经过 V2 API 校验的运单快照。若本地开发环境没有 V2 服务，应提供“开发模式”说明，但最终验收必须对接真实 V2 API。

## 15. 文档交付物

### 15.1 系统间接口文档

文件建议：`docs/system-integration-api.md`

必须包含：

- V3 调用 V2 的接口列表。
- 入参、出参、错误码。
- 鉴权方式。
- 超时配置。
- 重试策略。
- Request ID 传递规则。
- V2 不可用降级方案。
- V2 接口版本升级兼容策略。

### 15.2 需求理解与假设说明

文件建议：`docs/requirements-assumptions.md`

必须覆盖考试要求的九项：

1. 分级审批金额阈值。
2. 审批超时时长。
3. 重提次数上限。
4. 物流异常类型映射。
5. 角色权限划分。
6. V2 数据同步频率与一致性策略。
7. 品控暂扣超时时长。
8. 品控规则触发阈值。
9. 品控主管角色权限边界。

还需包含：

- 如果 V2 没有现成接口，如何新增接口且不破坏现有调用方。
- 如果 V2 字段类型变化，例如金额从 `int` 变成 `decimal`，V3 如何兼容。
- 如果能向产品经理提问，会问的问题清单。

## 16. 验收用例

### 16.1 V2 接口真实性

1. 输入不存在的 V2 运单 ID 创建异常。
2. 期望：V3 调用 V2，返回“不存在”，不创建工单，`integration_logs` 有失败日志。

### 16.2 人工物流异常完整流

1. 选择真实 V2 运单。
2. 上报丢件，金额 800 元。
3. 一级审批通过。
4. 期望：工单 `completed`，生成客户赔付记录和库存重发流水。

### 16.3 二级审批流

1. 上报破损，金额 3000 元。
2. 期望：进入二级审批。
3. 二级审批通过。
4. 期望：赔付/库存记录关联审批记录。

### 16.4 拒绝重提上限

1. 同一工单连续拒绝并重提 2 次。
2. 第 3 次拒绝。
3. 期望：自动关闭为 `closed_rejected_limit`。

### 16.5 并发冲突

1. 两个审批人同时打开同一工单。
2. A 审批通过。
3. B 再提交拒绝。
4. 期望：B 收到版本冲突提示，不产生矛盾审批记录。

### 16.6 重复点击幂等

1. 同一审批请求重复提交。
2. 期望：只生成一条审批记录、一套赔付/库存记录。

### 16.7 扫描品控通过

1. 输入真实运单和归属 SKU。
2. 实扫数量与 V2 一致，规格一致。
3. 期望：扫描记录 `qc_passed`，不创建工单。

### 16.8 扫描品控异常

1. 输入真实运单和归属 SKU。
2. 实扫数量与 V2 不一致。
3. 期望：命中数量不符规则，批次 `qc_hold`，自动创建品控工单并进入二级审批。

### 16.9 扫描幂等

1. 同一运单、同一 SKU、同一批次重复扫描异常。
2. 期望：只保留一个未关闭品控工单，追加多条扫描记录。

### 16.10 快速放行

1. 使用非品控主管账号操作快速放行。
2. 期望：后端拒绝。
3. 使用品控主管账号填写原因并快速放行。
4. 期望：工单完成、批次解锁、审计日志可查。

### 16.11 V2 不可用降级

1. 临时配置错误的 V2 API 地址。
2. 打开工单详情。
3. 期望：可展示本地缓存并明确标注缓存时间。
4. 尝试新建异常。
5. 期望：因无法实时校验而禁止创建。

### 16.12 接口监控

1. 完成若干 V2 调用，包括成功和失败。
2. 期望：`/integrations` 能按 Request ID 查看调用时间、接口、状态、耗时、错误。

## 17. 实施顺序

建议研发 agent 按以下顺序实现：

1. 创建独立 V3 Next.js 项目，复用 V2 视觉变量和组件风格。
2. 如 V2 缺少 API，先在 V2 新增 `/api/v1` 只读接口和鉴权。
3. 在 V3 建立数据库 schema、迁移和种子脚本。
4. 实现 `v2-client.ts`，包含鉴权、超时、重试、Request ID、日志写入。
5. 实现运单快照刷新逻辑。
6. 实现人工异常上报。
7. 实现审批规则、审批状态机、权限校验、乐观锁。
8. 实现执行联动：赔付、库存、审计。
9. 实现扫描录入和品控规则引擎。
10. 实现扫描幂等、批次锁定、快速放行。
11. 实现超时任务。
12. 实现列表、详情、审批页、规则页、接口监控页。
13. 生成 200 条演示数据。
14. 补齐 `docs/system-integration-api.md` 和 `docs/requirements-assumptions.md`。
15. 运行 lint/build，部署 Vercel。

## 18. 完成标准

项目完成时必须满足：

- `npm run build` 通过。
- Vercel 可访问。
- V3 使用独立数据库。
- V3 通过 HTTP API 调用 V2。
- 发起异常和扫描 SKU 归属校验均有真实 V2 调用日志。
- 页面风格与 V2 统一。
- 工单状态机和扫描批次状态机分离。
- 审批并发冲突、幂等、权限边界可验证。
- 赔付和库存联动可追溯到审批记录。
- 接口监控页可定位跨系统调用问题。
- 至少 200 条演示工单。
- 两份交付文档完整存在。

