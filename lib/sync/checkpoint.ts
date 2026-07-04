import { existsSync, readFileSync, writeFileSync } from "fs";
import { CHECKPOINT_FILE } from "../constants";

/**
 * Local resume checkpoint keyed by page URL, so an interrupted `npm run
 * sync:full` (e.g. hitting a rate limit partway through) can be re-run and
 * skip everything already embedded and saved, instead of starting over from
 * page one.
 *
 * IMPORTANT — this only helps where the filesystem persists between runs. On
 * Vercel, `/api/sync` runs in a fresh, mostly-read-only serverless filesystem
 * on every invocation (writes only succeed under /tmp, and even that doesn't
 * persist between invocations), so writes here silently no-op there rather
 * than throwing — the cron route just falls back to reprocessing whatever the
 * incremental `modified_after` cutoff selects. On a persistent server
 * deployment (AWS EC2/ECS/Docker, see lib/scheduler.ts), this file lives on
 * that server's own disk and works exactly like the local CLI case. True
 * cross-invocation resumability for the serverless path would need the
 * checkpoint stored in Postgres instead of a local file.
 */

export type PageStatus = "done" | "failed";

export interface CheckpointEntry {
  sourceUrl: string;
  postType: string;
  modified: string | null;
  chunkCount: number;
  status: PageStatus;
  timestamp: string;
  error?: string;
}

export interface CheckpointState {
  entries: Record<string, CheckpointEntry>;
}

let warnedAboutReadOnlyFs = false;

export function loadCheckpoint(): CheckpointState {
  if (!existsSync(CHECKPOINT_FILE)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.entries) return parsed as CheckpointState;
    return { entries: {} };
  } catch {
    return { entries: {} };
  }
}

export function saveCheckpoint(state: CheckpointState): void {
  try {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    if (!warnedAboutReadOnlyFs) {
      warnedAboutReadOnlyFs = true;
      console.warn(
        `[checkpoint] Could not write ${CHECKPOINT_FILE} (read-only filesystem?) — continuing without resume support: ${(err as Error).message}`
      );
    }
  }
}

export function isAlreadyDone(state: CheckpointState, sourceUrl: string, modified: string | null): boolean {
  const entry = state.entries[sourceUrl];
  if (!entry || entry.status !== "done" || entry.modified !== modified) return false;
  // A "done" page with zero chunks usually means REST content was empty and
  // no fallback existed at the time it was synced (see sync-runner.ts's
  // generic scrape fallback, added after some pages were already
  // checkpointed this way) — always worth retrying rather than treating as
  // permanently finished, since retrying costs one HTTP fetch, not quota.
  return entry.chunkCount > 0;
}

export function recordResult(state: CheckpointState, entry: CheckpointEntry): void {
  state.entries[entry.sourceUrl] = entry;
}
