import { streamText, type LanguageModel, type ModelMessage, type StopCondition, type ToolSet, type UIMessageChunk } from "ai";
import { getActiveKey, keyCount, markKeyExhausted } from "./key-pool";
import { isRotatableKeyError } from "../sync/retry";

/**
 * Deliberately narrower than streamText's full (heavily overloaded/generic)
 * parameter type — just the fields this route actually needs to vary per
 * key. Cast at the call site below; streamText's real generic signature
 * doesn't infer cleanly through a callback indirection like this one.
 */
interface ChatGenerationParams {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Runs streamText with automatic key rotation (lib/openai/key-pool.ts) on a
 * quota/rate-limit/invalid-key error. Chat generation can't safely rotate
 * keys *mid-stream* — once bytes have started flowing to the client,
 * restarting on a new key would mean either a broken stream or a duplicated
 * response. So this fully generates the reply server-side first, buffering
 * it into an array of UI message chunks, and only returns once a clean
 * result is available (or every key has been tried).
 *
 * The trade-off: the client loses live token-by-token streaming in exchange
 * for the current request actually succeeding when the *first* key it tries
 * is rate-limited, not just requests after it.
 */
export async function generateWithKeyFailover(
  buildParams: (apiKey: string) => ChatGenerationParams
): Promise<UIMessageChunk[]> {
  const attempts = Math.max(1, keyCount());
  let chunks: UIMessageChunk[] = [];

  for (let i = 0; i < attempts; i++) {
    const apiKey = getActiveKey();
    let capturedError: unknown;

    const result = streamText({
      ...buildParams(apiKey),
      onError: ({ error }) => {
        capturedError = error;
      },
    } as Parameters<typeof streamText>[0]);

    chunks = [];
    for await (const chunk of result.toUIMessageStream()) {
      chunks.push(chunk);
    }

    if (!capturedError) return chunks;

    console.error(`[chat] generation failed on key ending ...${apiKey.slice(-6)}:`, capturedError);

    if (isRotatableKeyError(capturedError) && keyCount() > 1 && i < attempts - 1) {
      markKeyExhausted(apiKey);
      continue;
    }

    // Out of keys, or a non-rotatable error — return what we have (it
    // contains an "error" chunk the client already knows how to render).
    return chunks;
  }

  return chunks;
}
