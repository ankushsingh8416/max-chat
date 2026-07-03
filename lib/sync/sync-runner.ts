import { discoverPostTypes, fetchAllContent } from "../wp/client";
import { cleanHtmlToText } from "../content/clean";
import { fetchGenericPageText, resolveProjectStructuredData } from "../content/extract";
import { chunkContent } from "../content/chunk";
import { embedTexts, getRetryCount, resetRetryCount } from "./embedding-service";
import { getSupabaseAdmin } from "../supabase/client";
import { PROJECT_TYPE_SLUGS } from "../constants";
import { isDailyQuotaExhaustedError } from "./retry";
import {
  isAlreadyDone,
  loadCheckpoint,
  recordResult,
  saveCheckpoint,
  type CheckpointState,
} from "./checkpoint";
import { formatDuration, logError, logInfo, logSuccess, logWarn, newLine, renderProgressBar } from "./logger";
import type { WPContentItem, WPPostType } from "../wp/types";
import type { ContentChunkRow } from "../supabase/types";

export interface SyncOptions {
  /** Force a complete re-fetch of every post type from WordPress, ignoring the incremental cutoff. */
  full?: boolean;
  /** Discard the local resume checkpoint and re-embed everything, even pages already marked done. */
  resetCheckpoint?: boolean;
}

export interface SyncReport {
  status: "success" | "partial" | "failed";
  pagesSynced: number;
  chunksCreated: number;
  pagesSkipped: number;
  pagesNotAttempted: number;
  retryCount: number;
  elapsedMs: number;
  errors: string[];
  failedPages: string[];
  stoppedEarly: boolean;
}

async function getLastSuccessfulRunAt(): Promise<string | undefined> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("sync_logs")
    .select("run_at")
    .eq("status", "success")
    .order("run_at", { ascending: false })
    .limit(1);
  return data?.[0]?.run_at;
}

interface ItemResult {
  chunkCount: number;
  skipped: boolean;
}

/**
 * Below this many characters, `content.rendered` from the REST API is
 * treated as "effectively empty" and the generic HTML-scrape fallback runs
 * instead — common for page-builder marketing pages (About, Investors,
 * Sustainability, etc.) whose real content lives outside the WP content
 * editor field entirely. Applies to every post type, not just projects.
 */
const MIN_REST_CONTENT_LENGTH = 200;

async function syncSingleItem(item: WPContentItem, postType: WPPostType, checkpoint: CheckpointState): Promise<ItemResult> {
  if (isAlreadyDone(checkpoint, item.link, item.modified_gmt)) {
    return { chunkCount: 0, skipped: true };
  }

  const admin = getSupabaseAdmin();
  const title = cleanHtmlToText(item.title.rendered) || "(untitled)";
  let bodyText = cleanHtmlToText(item.content.rendered);

  const structuredData = PROJECT_TYPE_SLUGS.has(postType.slug)
    ? await resolveProjectStructuredData(item)
    : undefined;

  if (bodyText.length < MIN_REST_CONTENT_LENGTH) {
    try {
      const scraped = await fetchGenericPageText(item.link);
      if (scraped.length > bodyText.length) bodyText = scraped;
    } catch (err) {
      logWarn(`[${postType.slug}] generic scrape fallback failed for ${item.link}: ${(err as Error).message}`);
    }
  }

  const chunks = chunkContent(bodyText, structuredData);
  if (chunks.length === 0) {
    recordResult(checkpoint, {
      sourceUrl: item.link,
      postType: postType.slug,
      modified: item.modified_gmt,
      chunkCount: 0,
      status: "done",
      timestamp: new Date().toISOString(),
    });
    return { chunkCount: 0, skipped: false };
  }

  // Batched, rate-limited, retried — see lib/sync/embedding-service.ts.
  const embeddings = await embedTexts(chunks.map((c) => c.text));

  // Delete stale chunks for this page before inserting fresh ones, so a
  // shrinking page (fewer chunks than last time) never leaves orphans behind.
  const { error: deleteError } = await admin.from("content_chunks").delete().eq("source_url", item.link);
  if (deleteError) throw new Error(`delete old chunks failed: ${deleteError.message}`);

  const rows: ContentChunkRow[] = chunks.map((chunk, i) => ({
    source_url: item.link,
    title,
    post_type: postType.slug,
    chunk_text: chunk.text,
    chunk_index: chunk.chunkIndex,
    structured_data: chunk.structuredData ?? null,
    embedding: embeddings[i],
    last_modified: item.modified_gmt,
  }));

  const { error: insertError } = await admin.from("content_chunks").insert(rows);
  if (insertError) throw new Error(`insert chunks failed: ${insertError.message}`);

  recordResult(checkpoint, {
    sourceUrl: item.link,
    postType: postType.slug,
    modified: item.modified_gmt,
    chunkCount: rows.length,
    status: "done",
    timestamp: new Date().toISOString(),
  });

  return { chunkCount: rows.length, skipped: false };
}

/**
 * Runs the full content sync: discovers post types, fetches new/changed
 * content (or everything, with `full: true`), extracts + chunks + embeds it,
 * and upserts it into Supabase. Always does a full re-sync for project-type
 * content regardless of the incremental cutoff, since price/availability can
 * change without WP bumping `modified`.
 *
 * A local checkpoint (lib/sync/checkpoint.ts) tracks which pages already
 * finished successfully, so re-running after a quota-driven interruption
 * resumes instead of reprocessing everything — see that module's docs for
 * why this only helps the local CLI path, not the Vercel cron route.
 */
export async function runContentSync(opts: SyncOptions = {}): Promise<SyncReport> {
  const startedAt = Date.now();
  const admin = getSupabaseAdmin();
  const errors: string[] = [];
  const failedPages: string[] = [];
  let pagesSynced = 0;
  let chunksCreated = 0;
  let pagesSkipped = 0;

  resetRetryCount();
  const checkpoint = opts.resetCheckpoint ? { entries: {} } : loadCheckpoint();

  const modifiedAfter = opts.full ? undefined : await getLastSuccessfulRunAt();
  const postTypes = await discoverPostTypes();

  logInfo(
    `Starting ${opts.full ? "FULL" : "incremental"} sync across ${postTypes.length} post types` +
      (modifiedAfter ? ` (since ${modifiedAfter})` : "")
  );

  let pagesNotAttempted = 0;
  let stoppedEarly = false;

  postTypeLoop: for (const postType of postTypes) {
    const isProjectType = PROJECT_TYPE_SLUGS.has(postType.slug);
    const effectiveCutoff = isProjectType ? undefined : modifiedAfter;

    let items: WPContentItem[];
    try {
      items = await fetchAllContent(postType.rest_base, { modifiedAfter: effectiveCutoff });
    } catch (err) {
      const msg = `[${postType.rest_base}] fetch failed: ${(err as Error).message}`;
      logError(msg);
      errors.push(msg);
      continue;
    }

    logInfo(`${postType.rest_base}: ${items.length} item(s) to process`);
    const typeStartedAt = Date.now();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const result = await syncSingleItem(item, postType, checkpoint);
        if (result.skipped) {
          pagesSkipped += 1;
        } else {
          pagesSynced += 1;
          chunksCreated += result.chunkCount;
        }
      } catch (err) {
        if (isDailyQuotaExhaustedError(err)) {
          newLine();
          logError(
            "Daily embedding quota exhausted — stopping this run early instead of retrying every remaining page. " +
              "Resume with `npm run sync:full` once the quota resets (see README)."
          );
          stoppedEarly = true;
          pagesNotAttempted += items.length - i; // this item plus everything after it in every remaining type
          break postTypeLoop;
        }

        const msg = `[${postType.rest_base}] ${item.link}: ${(err as Error).message}`;
        failedPages.push(item.link);
        errors.push(msg);
        recordResult(checkpoint, {
          sourceUrl: item.link,
          postType: postType.slug,
          modified: item.modified_gmt,
          chunkCount: 0,
          status: "failed",
          timestamp: new Date().toISOString(),
          error: (err as Error).message,
        });
      } finally {
        // Persisted after every item — never lose more than one item's worth
        // of progress if the process is killed or a daily quota cuts it off.
        saveCheckpoint(checkpoint);
        const elapsed = Date.now() - typeStartedAt;
        const avgPerItem = elapsed / (i + 1);
        const etaMs = avgPerItem * (items.length - i - 1);
        renderProgressBar(i + 1, items.length, `${postType.rest_base} ${i + 1}/${items.length}`, etaMs);
      }
    }
    newLine();
  }

  const elapsedMs = Date.now() - startedAt;
  const retryCount = getRetryCount();
  const status: SyncReport["status"] = errors.length === 0 ? "success" : pagesSynced > 0 ? "partial" : "failed";

  const { error: logInsertError } = await admin.from("sync_logs").insert({
    status,
    pages_synced: pagesSynced,
    chunks_created: chunksCreated,
    errors,
  });
  if (logInsertError) logWarn(`Failed to write sync_logs entry: ${logInsertError.message}`);

  const report: SyncReport = {
    status,
    pagesSynced,
    chunksCreated,
    pagesSkipped,
    pagesNotAttempted,
    retryCount,
    elapsedMs,
    errors,
    failedPages,
    stoppedEarly,
  };
  printFinalReport(report);
  return report;
}

function printFinalReport(report: SyncReport): void {
  newLine();
  logInfo("=== Sync report ===");
  logSuccess(`${report.pagesSynced} page(s) synced`);
  if (report.pagesSkipped > 0) logInfo(`${report.pagesSkipped} page(s) skipped (already up to date per checkpoint)`);
  logInfo(`${report.chunksCreated} chunk(s) created`);
  if (report.retryCount > 0) logWarn(`${report.retryCount} retry attempt(s) across all requests`);
  if (report.failedPages.length > 0) {
    logError(`${report.failedPages.length} page(s) failed:`);
    report.failedPages.slice(0, 20).forEach((url) => console.log(`    - ${url}`));
    if (report.failedPages.length > 20) console.log(`    ...and ${report.failedPages.length - 20} more`);
  }
  if (report.stoppedEarly) {
    logWarn(`Stopped early due to daily quota exhaustion — at least ${report.pagesNotAttempted} page(s) not yet attempted this run.`);
  }
  logInfo(`Elapsed: ${formatDuration(report.elapsedMs)}`);
  logInfo(`Status: ${report.status}`);
}
