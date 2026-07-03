import { getSupabaseAdmin } from "./supabase/client";

const HINGLISH_WORDS = ["kya", "hai", "kitna", "kitne", "batao", "kaha", "kahan", "mujhe", "chahiye"];

function detectLanguageHint(question: string): string {
  if (/[ऀ-ॿ]/.test(question)) return "hindi";
  const lower = question.toLowerCase();
  if (HINGLISH_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(lower))) return "hinglish";
  return "english";
}

/**
 * Fire-and-forget analytics logging — anonymized (question text + whether a
 * relevant answer was found), no IP/user identifiers stored. Never throws:
 * a logging failure must not affect the chat response.
 */
export function logChatAnalytics(question: string, answerFound: boolean, matchedChunkCount: number): void {
  const admin = getSupabaseAdmin();
  admin
    .from("chat_analytics")
    .insert({
      question,
      answer_found: answerFound,
      matched_chunk_count: matchedChunkCount,
      language_hint: detectLanguageHint(question),
    })
    .then(({ error }) => {
      if (error) console.error("[analytics] failed to log:", error.message);
    });
}
