"use client";

import { cn } from "@/lib/utils";

const STATUS_META: Record<string, { label: string; tag: string }> = {
  draft: { label: "草稿", tag: "tag-gray" },
  pending_review: { label: "待重审", tag: "tag-orange" },
  level1_reviewing: { label: "一级审批中", tag: "tag-teal" },
  level2_reviewing: { label: "二级审批中", tag: "tag-blue" },
  rejected: { label: "已拒绝(可重提)", tag: "tag-red" },
  auto_rejected_timeout: { label: "超时自动拒", tag: "tag-red" },
  closed_rejected_limit: { label: "重提上限已关闭", tag: "tag-gray" },
  executing: { label: "执行中", tag: "tag-orange" },
  completed: { label: "已完成", tag: "tag-green" },
  closed: { label: "已关闭", tag: "tag-gray" },
  qc_hold: { label: "品控暂扣", tag: "tag-orange" },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, tag: "tag-gray" };
  return <span className={cn("tag", meta.tag)}>{meta.label}</span>;
}

const SEVERITY_META: Record<string, { label: string; tag: string }> = {
  low: { label: "低", tag: "tag-gray" },
  medium: { label: "中", tag: "tag-orange" },
  high: { label: "高", tag: "tag-red" },
};

export function SeverityBadge({ severity }: { severity: string }) {
  const meta = SEVERITY_META[severity] ?? { label: severity, tag: "tag-gray" };
  return <span className={cn("tag", meta.tag)}>{meta.label}</span>;
}

const SUBTYPE_LABELS: Record<string, string> = {
  loss: "丢件",
  damage: "破损",
  wrong_item: "错发",
  missing_item: "少发",
  delivery_failure: "配送失败",
  address_error: "地址错误",
  other: "其他",
};

export function subtypeLabel(subtype: string): string {
  return SUBTYPE_LABELS[subtype] ?? subtype;
}

const SOURCE_LABELS: Record<string, string> = {
  manual_report: "人工上报",
  scan_qc: "扫码品控",
  auto_timeout: "超时生成",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
