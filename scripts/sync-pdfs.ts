/**
 * CLI entry point for syncing PDF brochures/reports from
 * https://maxestates.in/downloads — content the WordPress REST API has no
 * visibility into (static files, not posts/pages). Shares the checkpoint,
 * retry, and embedding pipeline with the main content sync.
 *
 *   npm run sync:pdfs
 *   npm run sync:pdfs -- --reset-checkpoint
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runPdfSync } from "../lib/sync/pdf-sync";

async function main() {
  const resetCheckpoint = process.argv.includes("--reset-checkpoint");
  const result = await runPdfSync({ resetCheckpoint });
  process.exit(result.status === "failed" ? 1 : 0);
}

main().catch((err) => {
  console.error("[sync:pdfs] Fatal error:", err);
  process.exit(1);
});
