import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function formatDateTime(dateStr: string | Date | null | undefined): string {
  if (!dateStr) return "-";
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 即将超时：距截止时间不足 4 小时，且尚未超时 */
export function isTimeoutUrgent(dueAt: string | Date | null | undefined): boolean {
  if (!dueAt) return false;
  const ms = typeof dueAt === "string" ? new Date(dueAt).getTime() : dueAt.getTime();
  if (isNaN(ms)) return false;
  const now = Date.now();
  return ms > now && ms - now <= 4 * 3600 * 1000;
}

/** 已超时 */
export function isTimeoutOverdue(dueAt: string | Date | null | undefined): boolean {
  if (!dueAt) return false;
  const ms = typeof dueAt === "string" ? new Date(dueAt).getTime() : dueAt.getTime();
  if (isNaN(ms)) return false;
  return ms <= Date.now();
}

// 生成工单号：V3 + YYYYMMDD + 6位随机
export function generateTicketNo(d: Date = new Date()): string {
  const ymd =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `V3-${ymd}-${rand}`;
}
