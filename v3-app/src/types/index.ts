// V3 领域类型定义（核心闭环子集）

export type RoleCode =
  | "operator"
  | "warehouse_operator"
  | "qc_supervisor"
  | "level1_approver"
  | "level2_approver"
  | "admin"
  | "auditor";

export type TicketSource = "manual_report" | "scan_qc";
export type TicketCategory = "logistics" | "quality_control";
export type Severity = "low" | "medium" | "high";

// 物流异常子类型
export type LogisticsSubtype = "lost" | "damaged" | "rejected" | "timeout_unsigned" | "address_error";

// 品控异常子类型（§3.2）
export type QcSubtype = "quantity_mismatch" | "damage" | "spec_mismatch" | "label_mismatch" | "batch_risk";

// 品控条件类型
export type QcConditionType = "quantity_diff" | "damage_level" | "spec_mismatch" | "label_mismatch" | "batch_risk";

// 扫描批次状态（§7.2）
export type ScanBatchStatus =
  | "scan_recorded"
  | "qc_passed"
  | "qc_hold"
  | "escalated"
  | "released"
  | "returned_supplier"
  | "repurchase_pending"
  | "downgraded"
  | "closed";

// 工单状态机（§7.1）
export type TicketStatus =
  | "draft"
  | "pending_review"
  | "level1_reviewing"
  | "level2_reviewing"
  | "rejected"
  | "executing"
  | "completed"
  | "closed"
  | "auto_rejected_timeout"
  | "closed_rejected_limit";

// 审批动作
export type ApprovalAction =
  | "approve"
  | "reject"
  | "auto_escalate"
  | "auto_reject"
  | "transfer"
  | "quick_release";

// 执行动作（§12.1 物流；§12.2 品控后续轮次）
export type ExecutionAction =
  | "pay_customer"
  | "reship"
  | "return_in"
  | "pay_customer_and_reship"
  | "address_correct_reship"
  // 品控后续轮次占位：
  | "release_goods"
  | "return_supplier_recover"
  | "repurchase_recover"
  | "downgrade_recover"
  | "quick_release";

// 库存动作类型
export type MovementType = "lock" | "unlock" | "outbound" | "return_in" | "scrap" | "repurchase";

// 赔付方向
export type CompensationDirection = "pay_customer" | "recover_supplier";

// API 错误码
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "TICKET_VERSION_CONFLICT"
  | "DUPLICATE_OPEN_TICKET"
  | "V2_UNAVAILABLE"
  | "WAYBILL_NOT_FOUND"
  | "SKU_NOT_BELONG"
  | "IDEMPOTENCY_CONFLICT"
  | "RESUBMIT_LIMIT_REACHED"
  | "INVALID_STATE_TRANSITION"
  | "INTERNAL";

export interface ApiException {
  code: ApiErrorCode;
  message: string;
  status: number;
}

// 简化用户对象（前端用）
export interface SimpleUser {
  id: string;
  name: string;
  roleCodes: string[];
}
