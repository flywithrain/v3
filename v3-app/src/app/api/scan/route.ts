import { NextResponse } from "next/server";

/** POST /api/scan — 占位接口：扫描品控闭环由后续轮次交付，本轮返回 501。 */
export async function POST() {
  return NextResponse.json(
    { code: "NOT_IMPLEMENTED", message: "扫描品控闭环由后续轮次交付，本轮暂未启用" },
    { status: 501 }
  );
}
