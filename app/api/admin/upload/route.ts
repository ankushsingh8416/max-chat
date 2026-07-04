import { NextRequest, NextResponse } from "next/server";
import { isAdminRequestAuthorized } from "@/lib/admin/auth";
import { processUpload } from "@/lib/uploads/process-upload";
import { MAX_UPLOAD_FILE_BYTES } from "@/lib/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!isAdminRequestAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${Math.floor(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)}MB)` },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await processUpload(file.name, buffer);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[api/admin/upload] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
