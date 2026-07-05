import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin/auth";
import { runContentSync } from "@/lib/sync/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Manual "recrawl now" trigger from /admin — same incremental sync as the scheduler/cron, just admin-initiated. */
export async function POST(req: NextRequest) {
  if (!isAdminRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await runContentSync({ full: false });
    return NextResponse.json(report);
  } catch (err) {
    console.error("[api/admin/sync] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
