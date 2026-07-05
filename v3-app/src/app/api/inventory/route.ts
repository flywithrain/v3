import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { inventoryItems, inventoryMovements } from "@/lib/db-schema";
import { desc } from "drizzle-orm";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";

/** GET /api/inventory — 库存列表 + 流水（§11.9 子集） */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser(req);
  if (!me) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });

  const items = await db.select().from(inventoryItems).orderBy(desc(inventoryItems.updatedAt));

  const movements = await db.select().from(inventoryMovements).orderBy(desc(inventoryMovements.createdAt)).limit(200);

  return apiOk({ items, movements });
}
