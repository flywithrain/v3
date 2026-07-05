import { NextResponse } from "next/server";

/** POST /api/jobs/timeout — 占位：超时流转任务由后续轮次交付，本轮 501。 */
export async function POST() {
  return NextResponse.json(
    { code: "NOT_IMPLEMENTED", message: "超时流转任务由后续轮次交付，本轮暂未启用" },
    { status: 501 }
  );
}
