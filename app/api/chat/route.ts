import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { GEMINI_CHAT_MODEL, MAX_MESSAGE_LENGTH } from "@/lib/constants";
import { retrieveContext, buildSystemPrompt } from "@/lib/rag";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logChatAnalytics } from "@/lib/analytics";
import { suggestContactFormTool } from "@/lib/tools";
import { getActiveKey, keyCount, markKeyExhausted } from "@/lib/gemini/key-pool";
import { isRotatableKeyError } from "@/lib/sync/retry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function extractText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

export async function POST(req: Request) {
  const ip = getClientIp(req.headers);
  const rateLimit = checkRateLimit(ip);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many messages. Please slow down and try again in a minute." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } }
    );
  }

  let body: { messages: UIMessage[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) {
    return Response.json({ error: "No messages provided" }, { status: 400 });
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const question = extractText(lastUserMessage);

  if (!question) {
    return Response.json({ error: "Message must contain text" }, { status: 400 });
  }
  if (question.length > MAX_MESSAGE_LENGTH) {
    return Response.json(
      { error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` },
      { status: 400 }
    );
  }

  let systemPrompt: string;
  let matchedChunkCount = 0;
  try {
    const { chunks } = await retrieveContext(question);
    matchedChunkCount = chunks.length;
    systemPrompt = buildSystemPrompt(chunks);
  } catch (err) {
    console.error("[api/chat] retrieval failed:", err);
    // Degrade gracefully: let the model answer with no context rather than hard-failing the request.
    systemPrompt = buildSystemPrompt([]);
  }

  logChatAnalytics(question, matchedChunkCount > 0, matchedChunkCount);

  // Picked fresh per request (not module-level) so a key marked exhausted by
  // a previous request's onError is skipped on the very next one — see
  // lib/gemini/key-pool.ts. A mid-stream failure on *this* request still
  // reaches the client as an error (streaming responses can't be silently
  // retried once bytes are already flowing), but the key rotates out for
  // every request after it.
  const apiKey = getActiveKey();
  const google = createGoogleGenerativeAI({ apiKey });

  const result = streamText({
    model: google(GEMINI_CHAT_MODEL),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    tools: { suggestContactForm: suggestContactFormTool },
    // Default stopWhen is 1 step, which would cut the response off right at
    // the tool call with no accompanying text. Allow a second step so the
    // model can see the tool result and follow up with a short message.
    stopWhen: stepCountIs(2),
    providerOptions: {
      // Gemini 2.5 models "think" internally before deciding on tool calls
      // (see the thoughtSignature in tool-call responses) — explicitly
      // excluding thought content from the output stream, since when it
      // does leak through it shows up as raw pseudo-code/reasoning text
      // ("tool_code", "print(default_api...)", "thought ...") directly in
      // the user-visible reply.
      google: { thinkingConfig: { includeThoughts: false } },
    },
    onError: ({ error }) => {
      if (isRotatableKeyError(error) && keyCount() > 1) markKeyExhausted(apiKey);
      console.error("[api/chat] streamText error:", error);
    },
  });

  return result.toUIMessageStreamResponse();
}
