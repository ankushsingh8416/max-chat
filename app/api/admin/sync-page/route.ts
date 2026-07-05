import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin/auth";
import { syncSinglePage } from "@/lib/admin/sync-page";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!isAdminRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  try {
    const result = await syncSinglePage(body.url);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[api/admin/sync-page] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
