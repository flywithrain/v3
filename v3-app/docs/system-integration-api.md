# V3 ↔ V2 系统间接口文档

## 1. 概述

V3（运单全生命周期异常管理系统）通过 HTTP API 调用 V2（AI 录单解析系统）获取运单数据，两系统独立部署、独立数据库，不共享数据库连接。

本文档定义 V3 调用 V2 的所有接口、鉴权方式、超时与重试策略、降级方案及版本兼容策略。

## 2. 鉴权机制

| 项 | 说明 |
|---|---|
| 认证方式 | API Key（`X-API-Key` 请求头） |
| 请求追踪 | 每次请求携带 `X-Request-ID`，V2 响应体返回相同 `requestId` |
| 密钥管理 | 密钥存储于 V3 `.env.local`（`V2_API_KEY`），不进 git |
| 接口前缀 | V2 统一使用 `/api/v1/*`，不影响现有页面和 Server Actions |

## 3. 接口列表

### 3.1 校验/获取运单详情

```
GET /api/v1/shipments/lookup?shipmentId={id}
GET /api/v1/shipments/lookup?externalCode={externalCode}
```

**请求头**：`X-API-Key`, `X-Request-ID`

**响应**（200）：
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
      { "id": "uuid", "skuCode": "SKU001", "skuName": "商品名", "skuQuantity": "2", "skuSpec": "规格", "remark": "" }
    ]
  }
}
```

**错误码**：
- `404 WAYBILL_NOT_FOUND` — 运单不存在
- `401 UNAUTHORIZED` — API Key 无效

**调用场景**：发起异常上报时实时校验运单存在性（§3.5 真实性校验）

### 3.2 SKU 归属校验

```
GET /api/v1/shipments/{shipmentId}/sku/validate?skuCode={skuCode}
```

**响应**（200）：
```json
{
  "requestId": "req_xxx",
  "data": { "valid": true, "shipmentId": "uuid", "skuCode": "SKU001", "skuName": "商品名", "skuQuantity": "2", "skuSpec": "规格" }
}
```

**调用场景**：扫描录入时验证 SKU 确实在该运单的 SKU 明细中（考点7）

### 3.3 运单增量同步

```
GET /api/v1/shipments?updatedSince={ISO8601}&page=1&pageSize=100
```

**响应**（200）：分页列表，含运单摘要

**调用场景**：本地快照表初始化或增量同步（§6.6 定时同步，每 15 分钟）

### 3.4 异常标记回写（可选）

```
POST /api/v1/shipments/{shipmentId}/exception-marker
```

**请求体**：`{ hasOpenException: true, ticketNo: "TKT-xxx", category: "logistics" }`

**调用场景**：V3 有未关闭异常时通知 V2 显示提示，避免 V2 侧继续按正常运单处理

## 4. 超时与重试策略

| 项 | 配置 | 说明 |
|---|---|---|
| 超时时间 | 8000ms | 通过 `AbortController` 实现，超时后给用户明确提示 |
| 重试次数 | 最多 2 次（1 次重试） | 仅对 5xx 和网络错误重试；4xx 不重试 |
| 幂等保证 | 重试使用相同 `X-Request-ID` | V2 端可通过 Request ID 去重 |
| 日志记录 | 每次调用（含重试）均写入 `integration_logs` | 记录 Request ID、接口名、入参摘要、状态码、耗时、错误信息 |

**重试逻辑**：
- HTTP 5xx → 重试 1 次
- 网络错误/超时 → 重试 1 次
- HTTP 4xx → 不重试，直接返回错误
- HTTP 404 → 不重试，返回 `WAYBILL_NOT_FOUND`

## 5. V2 不可用降级方案

当 V2 服务整体不可用时（网络超时、5xx 连续失败）：

1. **工单详情页**：展示本地缓存快照，标注「使用本地缓存，同步于 YYYY-MM-DD HH:mm:ss，数据可能非最新」
2. **新建异常**：禁止创建（返回 503 `V2_UNAVAILABLE`），因无法做实时校验
3. **扫描操作**：禁止扫描通过（返回 503），因无法校验 SKU 归属
4. **恢复后**：系统自动恢复正常，无需人工介入
5. **接口监控页**：展示最近的失败调用，按错误分类（404/401/超时/5xx/网络错误）

## 6. Request ID 链路追踪

每次跨系统调用生成唯一 `Request ID`（格式 `req_{timestamp}-{random}`），贯穿：

1. V3 → V2 请求头 `X-Request-ID`
2. V2 响应体 `requestId` 字段
3. V3 `integration_logs` 表 `request_id` 列
4. V3 工单详情页可展示关联的 Request ID

通过 Request ID 可在 `integration_logs` 表中还原完整调用链：调用时间、接口名、入参摘要、响应状态码、耗时、错误信息。

## 7. 数据同步策略

| 场景 | 策略 | 说明 |
|---|---|---|
| 发起异常上报 | 实时调用 V2 | 刷新本地快照，确保运单存在（§3.5 真实性校验） |
| 扫描录入 | 实时调用 V2 | 校验 SKU 归属（考点7） |
| 列表/详情展示 | 优先本地快照 | 详情页提供「刷新 V2 最新数据」按钮 |
| 定时同步 | 每 15 分钟 | 增量同步最近 7 天有变更的运单快照 |

**V2 数据变更处理**：V2 运单信息在异常处理期间发生变更时（如金额更正），V3 通过实时校验感知差异，在工单详情页标注「V2 数据已变更，请确认」。

## 8. V2 接口版本升级兼容策略

### 8.1 新增接口不破坏现有调用方

V2 新增 `/api/v1/*` 接口采用以下原则：

1. **只新增文件**：不修改 V2 现有页面、Server Actions、数据库结构
2. **接口版本前缀**：统一 `/api/v1/`，与 V2 现有 `/api/*` 路由隔离
3. **向后兼容**：新增字段不删除已有字段；V3 侧对可选字段做 null 容错
4. **灰度上线**：先在 V2 本地验证，再部署到 Vercel

### 8.2 V2 字段类型变化处理

以金额字段从 `int` 改为 `decimal` 为例：

1. V3 侧 `waybill_snapshots.amount` 使用 `numeric` 类型（PostgreSQL），天然兼容 int/decimal
2. V3 接口解析层使用 `String()` 转换，避免 JS number 精度问题
3. V2 接口响应体保持 `string` 类型传递金额，V3 侧 `Number()` 解析
4. 若 V2 字段名变更，V3 通过 `raw_payload` jsonb 保留原始响应，兼容字段映射

### 8.3 版本感知

V3 快照表含 `source_version` 字段（当前 `v1`），V2 接口升级时递增版本号，V3 可据此判断数据格式并做兼容处理。
