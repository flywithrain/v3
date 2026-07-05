import { NextRequest } from "next/server";
import { getCurrentUser, apiOk, apiError } from "@/lib/auth";

/** GET /api/auth/me — 返回当前会话用户 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return apiError({ code: "UNAUTHORIZED", message: "未登录", status: 401 });
  return apiOk(user);
}
