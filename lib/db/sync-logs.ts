import { getPool } from "./pool";

export async function getLastSuccessfulRunAt(): Promise<string | undefined> {
  const { rows } = await getPool().query(
    `select run_at from sync_logs where status = 'success' order by run_at desc limit 1`
  );
  const runAt = rows[0]?.run_at as string | Date | undefined;
  return runAt ? new Date(runAt).toISOString() : undefined;
}

export async function insertSyncLog(
  status: "success" | "partial" | "failed",
  pagesSynced: number,
  chunksCreated: number,
  errors: string[]
): Promise<void> {
  await getPool().query(
    `insert into sync_logs (status, pages_synced, chunks_created, errors) values ($1, $2, $3, $4::jsonb)`,
    [status, pagesSynced, chunksCreated, JSON.stringify(errors)]
  );
}

export interface SyncLogSummary {
  runAt: string;
  status: "success" | "partial" | "failed";
  pagesSynced: number;
  chunksCreated: number;
  errorCount: number;
}

/** Most recent sync run of any status, for admin dashboard visibility (getLastSuccessfulRunAt only looks at successes). */
export async function getLatestSyncLog(): Promise<SyncLogSummary | null> {
  const { rows } = await getPool().query(
    `select run_at, status, pages_synced, chunks_created, jsonb_array_length(errors) as error_count
     from sync_logs order by run_at desc limit 1`
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    runAt: new Date(row.run_at).toISOString(),
    status: row.status,
    pagesSynced: row.pages_synced,
    chunksCreated: row.chunks_created,
    errorCount: row.error_count,
  };
}
