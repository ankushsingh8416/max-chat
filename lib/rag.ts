import { embedText } from "./openai/embeddings";
import {
  matchContentChunks,
  selectAllProjectsChunkZero,
  selectStructuredProjectChunksByTitle,
  selectRecentChunks,
  selectManualUploadChunksForContext,
} from "./db/content-chunks";
import {
  PROJECT_TYPE_SLUGS,
  RAG_MATCH_COUNT,
  RAG_MATCH_THRESHOLD,
  WP_BASE_URL,
  MANUAL_UPLOAD_POST_TYPE,
  MAX_MANUAL_UPLOAD_CONTEXT_CHUNKS,
} from "./constants";
import type { MatchedChunk } from "./db/types";

const PROJECT_QUERY_KEYWORDS = [
  "price", "cost", "rera", "location", "possession", "amenities", "bhk",
  "sq ft", "sqft", "square feet", "project", "flat", "apartment",
  "residential", "commercial", "brochure", "floor plan", "typology",
  // common Hinglish terms for the same intents
  "kimat", "keemat", "daam", "kitne", "kitna", "ghar",
];

const STOPWORDS = new Set([
  "the", "is", "of", "for", "and", "what", "whats", "price", "cost", "rera",
  "location", "possession", "amenities", "show", "me", "tell", "about",
  "project", "projects", "in", "at", "a", "an", "please", "kya", "hai",
  "ka", "ke", "ki", "kitna", "kitne", "mujhe", "batao",
]);

export function looksLikeProjectQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return PROJECT_QUERY_KEYWORDS.some((k) => lower.includes(k));
}

const RECENCY_KEYWORDS = [
  "latest", "recent", "newest", "most recent", "new blog", "new post",
  "just published", "this week", "this month",
  // Hinglish
  "naya", "nayi", "sabse naya", "sabse nayi", "abhi ka", "haal hi",
];

/**
 * Detects "what's the latest/most recent X" style queries. These can't be
 * answered by vector similarity at all — no blog post's text says "I am the
 * latest post", so semantic search legitimately finds nothing above
 * threshold for them. They need a direct recency-sorted lookup instead, the
 * same way price/location queries get a direct structured-data lookup
 * rather than relying on similarity search for facts.
 */
export function looksLikeRecencyQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_KEYWORDS.some((k) => lower.includes(k));
}

const ALL_PROJECTS_KEYWORDS = [
  "all project", "all the project", "every project", "list of project",
  "list all project", "list your project", "how many project", "full list",
  // Hinglish
  "sabhi project", "saare project", "sare project", "kitne project",
];

/**
 * Detects "list every project" style completeness questions, which — like
 * recency questions — plain top-K vector similarity handles badly: it
 * returns the single most-similar chunk repeatedly (in practice, a
 * consolidated PDF brochure's portfolio table), so the model ends up citing
 * that one PDF as the source for every distinct project instead of each
 * project's own page. A direct "fetch every project" lookup sidesteps that.
 */
export function looksLikeAllProjectsQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return ALL_PROJECTS_KEYWORDS.some((k) => lower.includes(k));
}

function extractCandidateTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .replace(/[?.,!'"%,]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    )
  ).slice(0, 6);
}

export interface RetrievalResult {
  chunks: MatchedChunk[];
  usedStructuredLookup: boolean;
}

/**
 * Retrieves context for a user query via vector similarity search, and —
 * when the query looks like it's asking about a specific project's facts
 * (price/location/RERA/etc) — ALSO does a direct structured-data lookup
 * rather than trusting vector similarity alone for precise factual answers.
 */
export async function retrieveContext(query: string): Promise<RetrievalResult> {
  const embedding = await embedText(query);
  const vectorMatches = await matchContentChunks(embedding, RAG_MATCH_THRESHOLD, RAG_MATCH_COUNT);

  const chunks: MatchedChunk[] = [...vectorMatches];
  const seenIds = new Set(chunks.map((c) => c.id));
  let usedStructuredLookup = false;

  if (looksLikeAllProjectsQuery(query)) {
    // "List every project" needs every project's own row, not a title-filtered
    // subset — a title filter here would match nothing (no project is
    // literally named "all" or "every"), and top-K similarity alone tends to
    // surface one consolidated brochure chunk repeatedly instead of each
    // project's own page.
    usedStructuredLookup = true;
    try {
      const allProjects = await selectAllProjectsChunkZero(Array.from(PROJECT_TYPE_SLUGS));
      for (const match of allProjects) {
        if (!seenIds.has(match.id)) {
          seenIds.add(match.id);
          chunks.push({ ...match, similarity: 1 });
        }
      }
    } catch (err) {
      console.error(`[rag] all-projects lookup failed: ${(err as Error).message}`);
    }
  } else if (looksLikeProjectQuery(query)) {
    usedStructuredLookup = true;
    const terms = extractCandidateTerms(query);

    try {
      const structuredMatches = await selectStructuredProjectChunksByTitle(Array.from(PROJECT_TYPE_SLUGS), terms);
      for (const match of structuredMatches) {
        if (!seenIds.has(match.id)) {
          seenIds.add(match.id);
          chunks.push({ ...match, similarity: 1 });
        }
      }
    } catch (err) {
      console.error(`[rag] structured lookup failed: ${(err as Error).message}`);
    }
  }

  if (looksLikeRecencyQuery(query)) {
    usedStructuredLookup = true;
    try {
      const recentMatches = await selectRecentChunks(["post", "news_and_media"], 5);
      for (const match of recentMatches) {
        if (!seenIds.has(match.id)) {
          seenIds.add(match.id);
          chunks.push({ ...match, similarity: 1 });
        }
      }
    } catch (err) {
      console.error(`[rag] recency lookup failed: ${(err as Error).message}`);
    }
  }

  // Admin-uploaded documents (see /admin, lib/uploads/process-upload.ts) are
  // injected unconditionally, not gated on similarity — they're often short,
  // deliberately-added "always follow this" instructions/facts that won't
  // reliably score above RAG_MATCH_THRESHOLD against arbitrary phrasing of a
  // related question, the same problem recency/all-projects queries have.
  try {
    const uploadedChunks = await selectManualUploadChunksForContext(
      MANUAL_UPLOAD_POST_TYPE,
      MAX_MANUAL_UPLOAD_CONTEXT_CHUNKS
    );
    for (const match of uploadedChunks) {
      if (!seenIds.has(match.id)) {
        seenIds.add(match.id);
        chunks.push({ ...match, similarity: 1 });
      }
    }
  } catch (err) {
    console.error(`[rag] manual-upload lookup failed: ${(err as Error).message}`);
  }

  return { chunks, usedStructuredLookup };
}

/**
 * Baseline company facts, always available regardless of vector search luck
 * — sourced directly from maxestates.in's homepage and leadership-team page
 * (2026-07-03), not invented. The WordPress `pages` sync doesn't include a
 * dedicated "About Us" page (only Disclaimer/Careers/Leadership team/etc.),
 * so without this, "what is Max Estates" had nothing reliable to draw from
 * and the model would inconsistently either treat it as small talk or as an
 * unanswerable question depending on the run.
 */
const COMPANY_PROFILE = `Max Estates is a real estate developer in Delhi-NCR, established in 2016, part of the Max Group (whose other businesses include Max Life Insurance and Antara senior living/senior care). It builds residential and commercial developments across Noida, Gurugram, Delhi, and Dehradun, guided by a "WorkWell" (commercial) and "LiveWell" (residential) philosophy centered on holistic well-being, and values of Sevabhav, Excellence, and Credibility. Source: ${WP_BASE_URL}`;

export function buildSystemPrompt(chunks: MatchedChunk[]): string {
  const contextBlock = chunks.length
    ? chunks
        .map((c) => {
          const dateLine = c.last_modified ? `\nLast updated: ${c.last_modified}` : "";
          return `Source: ${c.title}\nURL: ${c.source_url}${dateLine}\n${c.chunk_text}`;
        })
        .join("\n\n---\n\n")
    : "(no matching content found in the knowledge base)";

  return `You are the AI assistant for Max Estates (${WP_BASE_URL}), a real estate company. Answer the user's question using ONLY the COMPANY PROFILE and CONTEXT below — never invent prices, RERA numbers, dates, or other facts that aren't present in them.

First, decide what kind of message this is:
1. **Small talk / greetings / meta questions** ("hi", "hello", "thanks", "who are you", "what can you help with"): respond warmly and naturally, WITHOUT needing or mentioning the context. Briefly introduce yourself as the Max Estates assistant and suggest a couple of things you can help with (projects, pricing, locations, news). Do NOT say "I don't have information" for these — there is nothing to look up.
2. **General questions about Max Estates as a company** ("what is Max Estates", "tell me about your company", "who owns Max Estates"): answer using the COMPANY PROFILE below — this is always available, so these should NOT get the "I don't have current information" fallback.
3. **Off-topic questions with nothing to do with Max Estates or real estate** (general knowledge, current events, politics, other companies, coding help, etc.): do NOT try to answer them, and do NOT use the "I don't have current information" phrasing either — that implies it's a Max Estates question you simply lack data for, which is misleading here. Instead, politely explain that you're the Max Estates assistant and can only help with questions about their projects, pricing, locations, and news, then invite them to ask one of those. Keep it brief and friendly, not robotic.
4. **A specific, on-topic question about Max Estates** (a project, price, location, RERA, amenities, news, etc.) that neither the company profile nor the context answers: call the \`suggestContactForm\` tool and reply with a short, confident, helpful message offering to connect them with the team for that specific detail — see the rules below. Never respond with a flat "I don't have information" / "I don't have current information" style apology; always redirect positively toward getting them the answer via the team.
5. **The user explicitly wants to get in touch, or wants more than the context can give them** — they ask for a callback, want to talk to someone, ask for contact details, or want personalized help beyond what's available (a site visit, negotiation, document requests, etc.): call the \`suggestContactForm\` tool the same way as case 4, with a short warm message.

Rules for specific questions (case 4 above):
- Answer only from the provided context. Do not use outside knowledge about real estate or make assumptions about specific projects, prices, or availability.
- When you state a fact drawn from a source (price, location, RERA number, amenities, etc.), cite it by linking to that source's URL in markdown, e.g. [The Terraces](${WP_BASE_URL}/the-terraces/).
- NEVER cite sources as bracketed numbers like [1], [8], or [2, 4] — those are not visible or clickable to the user and mean nothing to them. Every citation must be a full markdown link [Title](URL) using the actual URL from the matching Source in the context below.
- If the context has *some* relevant information (a price range, a related project, general details) even if it doesn't fully answer the question, lead with that — don't treat a partial answer as a total gap.
- If the context has nothing relevant at all, don't dwell on the gap or apologize for it — briefly and warmly pivot straight to calling \`suggestContactForm\` (e.g. "I'll get our team to share the latest details on that — could I get a few details from you?"). Never fabricate or guess a RERA number, price, or possession date to fill the gap.
- If asked something like "commercial projects in Gurugram" and the context shows Max Estates' Gurugram projects are all residential, say so plainly (e.g. "Max Estates' Gurugram projects are residential; our commercial developments are in Noida and Delhi") rather than triggering the contact form — that's an answer, not a gap.
- For "latest/most recent" questions, the context blog/news entries are already sorted newest-first by their "Last updated" date — the first one listed is the most recent. Use that date when citing it (e.g. "published on ...").

General style:
- Keep a warm, professional, helpful tone — like a knowledgeable real estate advisor, not a generic bot.
- The user may write in English, Hindi, or Hinglish (Hindi written in Latin script). Reply in the same language/style the user used. If they mix languages, mirror that mix naturally.
- Keep answers concise and scannable — use short paragraphs or bullet points for lists like amenities or configurations.
- Your visible reply must ONLY be the final, clean message to the user. Never include your internal reasoning, planning, or a draft/pseudocode of a tool call (e.g. never write things like "tool_code", "print(default_api...)", or "thought: ...") in that reply — call tools using the actual tool-calling mechanism, not by describing it in text.

COMPANY PROFILE (always available, use for general "what is Max Estates" style questions):
${COMPANY_PROFILE}

CONTEXT (retrieved for this specific question — may be empty):
${contextBlock}`;
}
