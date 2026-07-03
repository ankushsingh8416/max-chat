import { CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS } from "../constants";
import type { ProjectStructuredData } from "../wp/types";

/** Cheap token estimate (~4 chars/token for English; good enough for chunk sizing, not billing). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SEPARATORS = ["\n\n", "\n", ". ", " "];

/**
 * Recursive character splitter: tries the coarsest separator first and only
 * falls back to a finer one for pieces that are still too large, then
 * greedily packs pieces into ~CHUNK_TARGET_TOKENS chunks with a sliding
 * overlap of ~CHUNK_OVERLAP_TOKENS between consecutive chunks.
 */
function splitRecursive(text: string, separators: string[]): string[] {
  if (estimateTokens(text) <= CHUNK_TARGET_TOKENS) return [text];
  const [sep, ...rest] = separators;
  if (!sep) {
    // Last resort: hard-slice by character count.
    const maxChars = CHUNK_TARGET_TOKENS * 4;
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) pieces.push(text.slice(i, i + maxChars));
    return pieces;
  }
  const parts = text.split(sep).filter(Boolean);
  return parts.flatMap((p) => (rest.length ? splitRecursive(p, rest) : [p]));
}

function packWithOverlap(pieces: string[], glue: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const piece of pieces) {
    const pieceTokens = estimateTokens(piece);
    if (currentTokens + pieceTokens > CHUNK_TARGET_TOKENS && current.length > 0) {
      chunks.push(current.join(glue));
      // carry overlap: keep trailing pieces worth ~CHUNK_OVERLAP_TOKENS
      let overlapTokens = 0;
      const overlapPieces: string[] = [];
      for (let i = current.length - 1; i >= 0; i--) {
        overlapTokens += estimateTokens(current[i]);
        overlapPieces.unshift(current[i]);
        if (overlapTokens >= CHUNK_OVERLAP_TOKENS) break;
      }
      current = overlapPieces;
      currentTokens = overlapTokens;
    }
    current.push(piece);
    currentTokens += pieceTokens;
  }
  if (current.length) chunks.push(current.join(glue));
  return chunks;
}

export interface TextChunk {
  text: string;
  chunkIndex: number;
  /** Present only on the chunk holding the atomic structured-data block. */
  structuredData?: ProjectStructuredData;
}

/**
 * Splits free-text prose into overlapping chunks, then — if structured data
 * is provided — prepends it as its own dedicated chunk (index 0) so it is
 * never split across a chunk boundary and can be retrieved precisely.
 */
export function chunkContent(text: string, structuredData?: ProjectStructuredData): TextChunk[] {
  const chunks: TextChunk[] = [];

  if (structuredData) {
    chunks.push({
      text: formatStructuredDataBlock(structuredData),
      chunkIndex: 0,
      structuredData,
    });
  }

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized) {
    const pieces = splitRecursive(normalized, SEPARATORS);
    const packed = packWithOverlap(pieces, " ");
    packed.forEach((chunkText) => {
      chunks.push({ text: chunkText.trim(), chunkIndex: chunks.length });
    });
  }

  return chunks.filter((c) => c.text.length > 0);
}

function formatStructuredDataBlock(data: ProjectStructuredData): string {
  const lines = ["Project details:"];
  if (data.price) lines.push(`Price: ${data.price}`);
  if (data.location) lines.push(`Location: ${data.location}`);
  if (data.rera) lines.push(`RERA number: ${data.rera}`);
  if (data.possession_date) lines.push(`Possession: ${data.possession_date}`);
  if (data.area_range) lines.push(`Area: ${data.area_range}`);
  if (data.configurations?.length) lines.push(`Configurations: ${data.configurations.join(", ")}`);
  if (data.amenities?.length) lines.push(`Amenities: ${data.amenities.join(", ")}`);
  return lines.join("\n");
}
