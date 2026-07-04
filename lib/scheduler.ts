import cron from "node-cron";
import { runContentSync } from "./sync/sync-runner";
import { runPdfSync } from "./sync/pdf-sync";
import { AUTO_SYNC_CRON_SCHEDULE } from "./constants";

let started = false;

/**
 * In-process daily sync scheduler for long-running server deployments (AWS
 * EC2/ECS/Docker via `next start`, or any host where the Node process stays
 * alive) — NOT applicable to serverless hosting (Vercel, AWS Lambda), where
 * the process doesn't persist between requests and vercel.json's own Cron
 * config (or an external scheduler hitting /api/sync) is required instead.
 *
 * Guarded to start at most once per server process — Next.js's dev server
 * can re-run instrumentation.ts's register() on hot reload, and this must
 * not register duplicate cron jobs each time.
 */
export function startAutoSyncScheduler(): void {
  if (started) return;
  started = true;

  if (!cron.validate(AUTO_SYNC_CRON_SCHEDULE)) {
    console.error(`[scheduler] Invalid AUTO_SYNC_CRON_SCHEDULE "${AUTO_SYNC_CRON_SCHEDULE}" — auto-sync disabled.`);
    return;
  }

  console.log(`[scheduler] Auto-sync enabled: "${AUTO_SYNC_CRON_SCHEDULE}" (incremental WordPress + PDF sync)`);

  cron.schedule(AUTO_SYNC_CRON_SCHEDULE, async () => {
    console.log("[scheduler] Running scheduled content sync...");
    try {
      const report = await runContentSync({ full: false });
      console.log(
        `[scheduler] Content sync finished: ${report.status} — ${report.pagesSynced} page(s), ${report.chunksCreated} chunk(s)`
      );
    } catch (err) {
      console.error("[scheduler] Scheduled content sync failed:", err);
    }

    console.log("[scheduler] Running scheduled PDF sync...");
    try {
      const report = await runPdfSync();
      console.log(
        `[scheduler] PDF sync finished: ${report.status} — ${report.pdfsSynced} PDF(s), ${report.chunksCreated} chunk(s)`
      );
    } catch (err) {
      console.error("[scheduler] Scheduled PDF sync failed:", err);
    }
  });
}
