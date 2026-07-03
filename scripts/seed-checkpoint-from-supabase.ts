/**
 * One-time backfill: populates the local resume checkpoint from whatever is
 * already sitting in Supabase's content_chunks table. Needed because the
 * checkpoint system was added after some pages had already been synced by
 * the pre-checkpoint pipeline — without this, a fresh `sync:full` wouldn't
 * know those pages are already done and would burn quota re-embedding them.
 *
 * Safe to run any time; it only ever marks pages "done", never touches
 * pages the checkpoint doesn't know about yet.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getSupabaseAdmin } from "../lib/supabase/client";
import { loadCheckpoint, saveCheckpoint, recordResult } from "../lib/sync/checkpoint";

async function main() {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.from("content_chunks").select("source_url, post_type, last_modified");
  if (error) throw new Error(`Failed to read content_chunks: ${error.message}`);

  const byUrl = new Map<string, { postType: string; modified: string | null; chunkCount: number }>();
  for (const row of data ?? []) {
    const existing = byUrl.get(row.source_url);
    if (existing) {
      existing.chunkCount += 1;
    } else {
      byUrl.set(row.source_url, { postType: row.post_type, modified: row.last_modified, chunkCount: 1 });
    }
  }

  const checkpoint = loadCheckpoint();
  let added = 0;
  for (const [sourceUrl, info] of byUrl) {
    if (checkpoint.entries[sourceUrl]) continue; // don't clobber existing entries
    recordResult(checkpoint, {
      sourceUrl,
      postType: info.postType,
      modified: info.modified,
      chunkCount: info.chunkCount,
      status: "done",
      timestamp: new Date().toISOString(),
    });
    added += 1;
  }

  saveCheckpoint(checkpoint);
  console.log(`Seeded checkpoint with ${added} page(s) already present in Supabase (${byUrl.size} total found, ${byUrl.size - added} already tracked).`);
}

main().catch((err) => {
  console.error("Failed to seed checkpoint:", err);
  process.exit(1);
});
