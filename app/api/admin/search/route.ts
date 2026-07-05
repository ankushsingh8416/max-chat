import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin/auth";
import { searchIndexedContent } from "@/lib/db/content-chunks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = req.nextUrl.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  try {
    const results = await searchIndexedContent(query, 20);
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[api/admin/search] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
