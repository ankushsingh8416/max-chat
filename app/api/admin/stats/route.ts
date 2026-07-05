import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin/auth";
import { getContentStats } from "@/lib/db/content-chunks";
import { getLatestSyncLog } from "@/lib/db/sync-logs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [contentStats, latestSync] = await Promise.all([getContentStats(), getLatestSyncLog()]);
    return NextResponse.json({ contentStats, latestSync });
  } catch (err) {
    console.error("[api/admin/stats] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
