/** Minimal ANSI-color CLI logger for the sync pipeline — no extra dependency. */

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${CODES.reset}` : text;
}

export function logInfo(message: string): void {
  console.log(paint(CODES.cyan, "→"), message);
}

export function logSuccess(message: string): void {
  console.log(paint(CODES.green, "✓"), message);
}

export function logWarn(message: string): void {
  console.log(paint(CODES.yellow, "⚠"), message);
}

export function logError(message: string): void {
  console.log(paint(CODES.red, "✗"), message);
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(message);
    return parsed?.error?.status ? `${parsed.error.status}` : message.slice(0, 60);
  } catch {
    return message.slice(0, 60);
  }
}

export function logRetry(attempt: number, waitMs: number, err: unknown): void {
  console.log(
    `  ${paint(CODES.yellow, `↻ retry #${attempt}`)} ${paint(CODES.dim, `waiting ${(waitMs / 1000).toFixed(1)}s (${summarizeError(err)})`)}`
  );
}

/**
 * Renders/updates a single in-place progress line via carriage return.
 * Call `newLine()` once the loop it's tracking finishes.
 */
export function renderProgressBar(current: number, total: number, label: string, etaMs?: number): void {
  const width = 24;
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(width * ratio);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = Math.round(ratio * 100);
  const eta = etaMs !== undefined && etaMs > 0 ? ` ETA ${formatDuration(etaMs)}` : "";
  process.stdout.write(`\r${paint(CODES.cyan, bar)} ${paint(CODES.bold, `${pct}%`)}  ${label}${eta}    `);
}

export function newLine(): void {
  process.stdout.write("\n");
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
