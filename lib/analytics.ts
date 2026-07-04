import { insertChatAnalytics } from "./db/chat-analytics";

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
  insertChatAnalytics(question, answerFound, matchedChunkCount, detectLanguageHint(question));
}
