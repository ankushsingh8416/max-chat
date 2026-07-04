import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin/auth";
import { selectManualUploads } from "@/lib/db/content-chunks";
import { MANUAL_UPLOAD_POST_TYPE } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const docs = await selectManualUploads(MANUAL_UPLOAD_POST_TYPE);
    return NextResponse.json({ docs });
  } catch (err) {
    console.error("[api/admin/docs] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
