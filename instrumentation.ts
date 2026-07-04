/**
 * Runs once when a new server instance starts (see Next.js's instrumentation
 * file convention). Used here to start the in-process auto-sync scheduler
 * (lib/scheduler.ts) so content stays fresh without a manual `npm run sync`
 * on a long-running deployment (AWS EC2/ECS/Docker) that has no external
 * cron infrastructure wired up.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoSyncScheduler } = await import("./lib/scheduler");
    startAutoSyncScheduler();
  }
}
