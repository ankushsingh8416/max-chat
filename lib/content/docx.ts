import mammoth from "mammoth";

/** Extracts plain text from an in-memory .docx buffer, for admin-uploaded documents. */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
