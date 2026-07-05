import { clearSessionCookie, apiOk } from "@/lib/auth";

/** POST /api/auth/logout — 清除会话 cookie */
export async function POST() {
  const res = apiOk({ ok: true });
  clearSessionCookie(res);
  return res;
}
