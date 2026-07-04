import { getPool } from "./pool";

/**
 * Fire-and-forget insert — never throws, since a logging failure must not
 * affect the chat response (see lib/analytics.ts, the caller).
 */
export function insertChatAnalytics(
  question: string,
  answerFound: boolean,
  matchedChunkCount: number,
  languageHint: string
): void {
  getPool()
    .query(
      `insert into chat_analytics (question, answer_found, matched_chunk_count, language_hint) values ($1, $2, $3, $4)`,
      [question, answerFound, matchedChunkCount, languageHint]
    )
    .catch((err) => console.error("[analytics] failed to log:", (err as Error).message));
}
