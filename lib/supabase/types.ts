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

export interface SyncLogRow {
  status: "success" | "partial" | "failed";
  pages_synced: number;
  chunks_created: number;
  errors: string[];
}

export interface ChatAnalyticsRow {
  question: string;
  answer_found: boolean;
  matched_chunk_count: number;
  language_hint?: string;
}
