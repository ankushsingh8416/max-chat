import { NextRequest, NextResponse } from "next/server";
import { runContentSync } from "@/lib/sync/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Pro allows up to 300s; sync can be slow on full runs.

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // never allow an unprotected sync route in production
  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${secret}`) return true; // Vercel Cron's convention
  const headerSecret = req.headers.get("x-cron-secret");
  return headerSecret === secret;
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const full = req.nextUrl.searchParams.get("full") === "true";

  try {
    const result = await runContentSync({ full });
    return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
  } catch (err) {
    console.error("[api/sync] Unhandled sync error:", err);
    return NextResponse.json({ error: "Sync failed", message: (err as Error).message }, { status: 500 });
  }
}

// Vercel Cron triggers scheduled functions with a GET request.
export const GET = handle;
// Also allow POST for manual/CI-triggered syncs.
export const POST = handle;
