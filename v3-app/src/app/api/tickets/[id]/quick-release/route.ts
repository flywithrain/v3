import { NextResponse } from "next/server";

/** POST /api/tickets/[id]/quick-release — 占位：误判快速放行由后续轮次交付，本轮 501。 */
export async function POST() {
  return NextResponse.json(
    { code: "NOT_IMPLEMENTED", message: "误判快速放行由后续轮次交付，本轮暂未启用" },
    { status: 501 }
  );
}
