import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin/auth";
import { deleteManualUpload } from "@/lib/db/content-chunks";
import { MANUAL_UPLOAD_POST_TYPE } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ docId: string }> }) {
  if (!isAdminRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { docId } = await params;
  const sourceUrl = decodeURIComponent(docId);
  if (!sourceUrl.startsWith("upload://")) {
    return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  }

  try {
    await deleteManualUpload(sourceUrl, MANUAL_UPLOAD_POST_TYPE);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/admin/docs/:docId] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
