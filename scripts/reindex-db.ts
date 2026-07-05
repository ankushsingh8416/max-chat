/**
 * Manually rebuilds the content_chunks vector index (see lib/db/maintenance.ts
 * for why this is ever necessary). Runs automatically after any
 * `--reset-checkpoint` sync, so you shouldn't normally need this — it's here
 * for recovering a database that was re-embedded before that automation
 * existed, or after directly restoring/migrating data outside the sync CLI.
 *
 *   npm run db:reindex
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { reindexEmbeddingIndex } from "../lib/db/maintenance";

async function main() {
  console.log("Rebuilding content_chunks vector index...");
  await reindexEmbeddingIndex();
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to reindex:", err);
  process.exit(1);
});
