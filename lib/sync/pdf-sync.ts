import { discoverDownloadLinks } from "../wp/downloads";
import { extractPdfText } from "../content/pdf";
import { chunkContent } from "../content/chunk";
import { embedTexts, getRetryCount, resetRetryCount } from "./embedding-service";
import { getSupabaseAdmin } from "../supabase/client";
import { isDailyQuotaExhaustedError } from "./retry";
import { isAlreadyDone, loadCheckpoint, recordResult, saveCheckpoint, type CheckpointState } from "./checkpoint";
import { formatDuration, logError, logInfo, logSuccess, logWarn, newLine, renderProgressBar } from "./logger";
import type { ContentChunkRow } from "../supabase/types";

const PDF_POST_TYPE = "pdf";

export interface PdfSyncOptions {
  /** Discard the local resume checkpoint and re-embed every PDF, even ones already marked done. */
  resetCheckpoint?: boolean;
}

export interface PdfSyncReport {
  status: "success" | "partial" | "failed";
  pdfsSynced: number;
  chunksCreated: number;
  pdfsSkipped: number;
  retryCount: number;
  elapsedMs: number;
  errors: string[];
  failedPdfs: string[];
  stoppedEarly: boolean;
}

async function syncSinglePdf(
  title: string,
  url: string,
  checkpoint: CheckpointState
): Promise<{ chunkCount: number; skipped: boolean }> {
  let lastModified: string | null = null;
  try {
    const headRes = await fetch(url, { method: "HEAD" });
    lastModified = headRes.headers.get("last-modified");
  } catch {
    // No Last-Modified available — fall through and just always (re)process this PDF.
  }

  if (isAlreadyDone(checkpoint, url, lastModified)) {
    return { chunkCount: 0, skipped: true };
  }

  const admin = getSupabaseAdmin();
  const { text } = await extractPdfText(url);
  const chunks = chunkContent(text);

  if (chunks.length === 0) {
    recordResult(checkpoint, {
      sourceUrl: url,
      postType: PDF_POST_TYPE,
      modified: lastModified,
      chunkCount: 0,
      status: "done",
      timestamp: new Date().toISOString(),
    });
    return { chunkCount: 0, skipped: false };
  }

  const embeddings = await embedTexts(chunks.map((c) => c.text));

  const { error: deleteError } = await admin.from("content_chunks").delete().eq("source_url", url);
  if (deleteError) throw new Error(`delete old chunks failed: ${deleteError.message}`);

  const rows: ContentChunkRow[] = chunks.map((chunk, i) => ({
    source_url: url,
    title,
    post_type: PDF_POST_TYPE,
    chunk_text: chunk.text,
    chunk_index: chunk.chunkIndex,
    structured_data: null,
    embedding: embeddings[i],
    last_modified: lastModified,
  }));

  const { error: insertError } = await admin.from("content_chunks").insert(rows);
  if (insertError) throw new Error(`insert chunks failed: ${insertError.message}`);

  recordResult(checkpoint, {
    sourceUrl: url,
    postType: PDF_POST_TYPE,
    modified: lastModified,
    chunkCount: rows.length,
    status: "done",
    timestamp: new Date().toISOString(),
  });

  return { chunkCount: rows.length, skipped: false };
}

/**
 * Syncs PDF brochures/reports linked from https://maxestates.in/downloads —
 * content the WordPress REST API has no visibility into at all, since these
 * are static files, not posts/pages. Shares the same checkpoint file, retry
 * logic, and embedding pipeline as the main WP content sync (lib/sync/sync-
 * runner.ts), so it's resumable and quota-aware the same way.
 */
export async function runPdfSync(opts: PdfSyncOptions = {}): Promise<PdfSyncReport> {
  const startedAt = Date.now();
  const admin = getSupabaseAdmin();
  const errors: string[] = [];
  const failedPdfs: string[] = [];
  let pdfsSynced = 0;
  let chunksCreated = 0;
  let pdfsSkipped = 0;
  let stoppedEarly = false;

  resetRetryCount();
  const checkpoint = opts.resetCheckpoint ? { entries: {} } : loadCheckpoint();

  logInfo("Discovering PDF links from /downloads...");
  const links = await discoverDownloadLinks();
  logInfo(`Found ${links.length} PDF(s) to process`);

  for (let i = 0; i < links.length; i++) {
    const { title, url } = links[i];
    try {
      const result = await syncSinglePdf(title, url, checkpoint);
      if (result.skipped) {
        pdfsSkipped += 1;
      } else {
        pdfsSynced += 1;
        chunksCreated += result.chunkCount;
      }
    } catch (err) {
      if (isDailyQuotaExhaustedError(err)) {
        newLine();
        logError(
          "Daily embedding quota exhausted — stopping PDF sync early. Resume with `npm run sync:pdfs` once quota resets."
        );
        stoppedEarly = true;
        saveCheckpoint(checkpoint);
        break;
      }

      const msg = `${title} (${url}): ${(err as Error).message}`;
      failedPdfs.push(url);
      errors.push(msg);
      recordResult(checkpoint, {
        sourceUrl: url,
        postType: PDF_POST_TYPE,
        modified: null,
        chunkCount: 0,
        status: "failed",
        timestamp: new Date().toISOString(),
        error: (err as Error).message,
      });
    } finally {
      saveCheckpoint(checkpoint);
      renderProgressBar(i + 1, links.length, `pdf ${i + 1}/${links.length}`);
    }
  }
  newLine();

  const elapsedMs = Date.now() - startedAt;
  const retryCount = getRetryCount();
  const status: PdfSyncReport["status"] = errors.length === 0 ? "success" : pdfsSynced > 0 ? "partial" : "failed";

  const { error: logInsertError } = await admin.from("sync_logs").insert({
    status,
    pages_synced: pdfsSynced,
    chunks_created: chunksCreated,
    errors,
  });
  if (logInsertError) logWarn(`Failed to write sync_logs entry: ${logInsertError.message}`);

  const report: PdfSyncReport = {
    status,
    pdfsSynced,
    chunksCreated,
    pdfsSkipped,
    retryCount,
    elapsedMs,
    errors,
    failedPdfs,
    stoppedEarly,
  };
  printFinalReport(report);
  return report;
}

function printFinalReport(report: PdfSyncReport): void {
  newLine();
  logInfo("=== PDF sync report ===");
  logSuccess(`${report.pdfsSynced} PDF(s) synced`);
  if (report.pdfsSkipped > 0) logInfo(`${report.pdfsSkipped} PDF(s) skipped (already up to date per checkpoint)`);
  logInfo(`${report.chunksCreated} chunk(s) created`);
  if (report.retryCount > 0) logWarn(`${report.retryCount} retry attempt(s) across all requests`);
  if (report.failedPdfs.length > 0) {
    logError(`${report.failedPdfs.length} PDF(s) failed:`);
    report.failedPdfs.forEach((url) => console.log(`    - ${url}`));
  }
  if (report.stoppedEarly) logWarn("Stopped early due to daily quota exhaustion.");
  logInfo(`Elapsed: ${formatDuration(report.elapsedMs)}`);
  logInfo(`Status: ${report.status}`);
}
