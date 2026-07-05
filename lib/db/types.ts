import type { ProjectStructuredData } from "../wp/types";

export interface ContentChunkRow {
  id?: number;
  source_url: string;
  title: string;
  post_type: string;
  chunk_text: string;
  chunk_index: number;
  structured_data: ProjectStructuredData | null;
  embedding: number[];
  last_modified: string | null;
  /** SHA-256 of the page's full extracted text — see sql/schema.sql. Omit where change detection isn't relevant (uploads, live fallback). */
  content_hash?: string | null;
}

export interface MatchedChunk {
  id: number;
  source_url: string;
  title: string;
  post_type: string;
  chunk_text: string;
  structured_data: ProjectStructuredData | null;
  last_modified: string | null;
  similarity: number;
}
