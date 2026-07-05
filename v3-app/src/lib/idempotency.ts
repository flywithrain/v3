import { db } from "@/lib/db";
import { approvalRecords } from "@/lib/db-schema";
import { eq } from "drizzle-orm";

/**
 * 幂等工具：审批/快速放行/超时任务均支持幂等（§13.2）。
 * - 前端操作传 Idempotency-Key（请求头）
 * - approval_records.idempotency_key 唯一约束兜底
 * - 重复请求：返回既有的同一 key 审批记录，不重复生成副作用
 *
 * 注意：实际写入靠 DB 唯一约束兜底。即插入失败（23505）时按 key 查回既有记录。
 */

export interface ExistingRecord {
  id: string;
  ticketId: string;
  action: string;
  createdAt: Date | null;
}

export async function findExistingByKey(idempotencyKey: string | null): Promise<ExistingRecord | null> {
  if (!idempotencyKey) return null;
  try {
    const rows = await db
      .select({
        id: approvalRecords.id,
        ticketId: approvalRecords.ticketId,
        action: approvalRecords.action,
        createdAt: approvalRecords.createdAt,
      })
      .from(approvalRecords)
      .where(eq(approvalRecords.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** 乐观锁版本校验（§13.1） */
export function checkVersion(expected: number, actual: number): boolean {
  return Number(expected) === Number(actual);
}
