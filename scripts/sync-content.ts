/**
 * CLI entry point for the content sync pipeline.
 *
 *   npm run sync                       -> incremental sync
 *   npm run sync -- --full             -> full re-sync of everything
 *   npm run sync -- --full --reset-checkpoint  -> ignore local resume checkpoint too
 *
 * Safe to interrupt (Ctrl+C) and re-run — see lib/sync/checkpoint.ts. The
 * final report (pages synced/skipped/failed, retries, elapsed time) is
 * printed by lib/sync/sync-runner.ts itself.
 */
// `dotenv/config`'s default side-effect import only loads `./.env`. This repo follows the
// Next.js convention of keeping local secrets in `.env.local` (see .env.example / README), so
// that has to be loaded explicitly — otherwise every env var is silently undefined here even
// though `next dev`/`next build` (which load .env.local natively) work fine.
import { config } from "dotenv";
config({ path: ".env.local" });
config(); // also pick up a plain .env if one exists, without overriding .env.local values

import { runContentSync } from "../lib/sync/sync-runner";

async function main() {
  const full = process.argv.includes("--full");
  const resetCheckpoint = process.argv.includes("--reset-checkpoint");
  const result = await runContentSync({ full, resetCheckpoint });
  process.exit(result.status === "failed" ? 1 : 0);
}

main().catch((err) => {
  console.error("[sync] Fatal error:", err);
  process.exit(1);
});
