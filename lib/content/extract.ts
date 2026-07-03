import * as cheerio from "cheerio";
import { fetchRenderedHtml } from "../wp/client";
import type { ProjectStructuredData, WPContentItem } from "../wp/types";

/**
 * WP exposes an `acf` key even without the "ACF to REST API" plugin properly
 * configured — it just comes back as `[]` (empty array) or `{}`. Only treat
 * it as usable if it actually carries keys/values.
 */
export function hasPopulatedAcf(acf: unknown): acf is Record<string, unknown> {
  if (!acf || typeof acf !== "object") return false;
  if (Array.isArray(acf)) return acf.length > 0;
  return Object.keys(acf as Record<string, unknown>).length > 0;
}

function extractFromAcf(acf: Record<string, unknown>): ProjectStructuredData {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = acf[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };

  const amenitiesRaw = get("amenities");
  const amenities = Array.isArray(amenitiesRaw)
    ? amenitiesRaw.map((a) => (typeof a === "string" ? a : (a as { title?: string })?.title || "")).filter(Boolean)
    : undefined;

  const data: ProjectStructuredData = {
    price: stringOrUndef(get("price", "starting_price", "price_range")),
    location: stringOrUndef(get("location", "address", "project_location")),
    rera: stringOrUndef(get("rera", "rera_number", "rera_no")),
    possession_date: stringOrUndef(get("possession_date", "possession")),
    area_range: stringOrUndef(get("area_range", "area", "carpet_area")),
    configurations: undefined,
    amenities,
    source: "acf",
    fields_missing: [],
  };
  data.fields_missing = missingFields(data);
  return data;
}

function stringOrUndef(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

function missingFields(d: ProjectStructuredData): string[] {
  const keys: (keyof ProjectStructuredData)[] = ["price", "location", "rera", "possession_date", "configurations", "area_range", "amenities"];
  return keys.filter((k) => {
    const v = d[k];
    return v === undefined || (Array.isArray(v) && v.length === 0);
  }) as string[];
}

const AMENITY_HEADING_WORDS = [
  "sports", "fitness", "food", "dining", "community", "healthcare", "health",
  "retail", "kids", "children", "work", "wellness", "recreation", "clubhouse",
  "amenities", "connectivity", "leisure", "security", "sustainability",
];

const CITY_WORDS = ["gurugram", "gurgaon", "noida", "delhi", "ncr", "dwarka expressway", "sector "];

/**
 * Best-effort structured-data scrape for a rendered project page. WordPress
 * page-builder markup rarely has stable class names, so this deliberately
 * uses text-pattern matching rather than brittle CSS selectors, and reports
 * which fields it could not find so pages can be checked manually.
 */
export function extractStructuredDataFromHtml(html: string, sourceUrl: string): ProjectStructuredData {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, noscript").remove();

  const blockText: string[] = [];
  $("body")
    .find("h1, h2, h3, h4, h5, li, p, span, div")
    .each((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim().replace(/\s+/g, " ");
      if (text && text.length < 300) blockText.push(text);
    });
  const fullText = blockText.join("\n");

  const price = matchFirst(fullText, /₹\s?[\d,]+(?:\.\d+)?\s*(?:Cr\.?|Crore|Lakh|L)\b\.?\+?/i);

  const reraMatch =
    matchFirst(fullText, /\bRC\/[A-Z]{2,4}\/[A-Z0-9/]+\b/i) ||
    matchFirst(fullText, /\b(?:RERA|Rera)[^\n:]{0,20}[:\-]?\s*([A-Z0-9/\-]{8,})/i, 1);

  const locationLine = blockText.find((line) => {
    const lower = line.toLowerCase();
    return CITY_WORDS.some((w) => lower.includes(w)) && line.length < 120;
  });

  const configurations = Array.from(
    new Set(
      (fullText.match(/\b\d(?:\.\d)?\s*(?:BHK|Bedroom)\b(?:\s*\([^)]*\))?/gi) || []).map((s) => s.trim())
    )
  ).slice(0, 12);

  const areaMatches = fullText.match(/[\d,]+\s*sq\.?\s?ft\.?/gi) || [];
  const areaRange = areaMatches.length
    ? `${areaMatches[0]}${areaMatches.length > 1 ? ` - ${areaMatches[areaMatches.length - 1]}` : ""}`
    : undefined;

  const possession =
    matchFirst(fullText, /possession[^\n.]{0,40}?(Q[1-4]\s?\d{4}|[A-Z][a-z]+\s\d{4}|ready to move)/i, 1) ||
    matchFirst(fullText, /ready to move/i);

  const amenities = Array.from(
    new Set(
      blockText.filter((line) => {
        const lower = line.toLowerCase();
        return (
          line.length < 60 &&
          !AMENITY_HEADING_WORDS.some((w) => lower === w) &&
          $.root().text().toLowerCase().includes(lower) &&
          /^[A-Za-z][A-Za-z &'/-]{2,58}$/.test(line) &&
          AMENITY_HEADING_WORDS.some((w) => nearHeading(blockText, line, w))
        );
      })
    )
  ).slice(0, 30);

  const data: ProjectStructuredData = {
    price,
    location: locationLine,
    rera: reraMatch,
    possession_date: possession,
    configurations: configurations.length ? configurations : undefined,
    area_range: areaRange,
    amenities: amenities.length ? amenities : undefined,
    source: "scrape",
    fields_missing: [],
  };
  data.fields_missing = missingFields(data);

  if (data.fields_missing.length > 0) {
    console.warn(
      `[extract] Missing fields [${data.fields_missing.join(", ")}] for ${sourceUrl} — manual inspection recommended.`
    );
  }

  return data;
}

function nearHeading(lines: string[], line: string, headingWord: string): boolean {
  const idx = lines.indexOf(line);
  if (idx === -1) return false;
  const window = lines.slice(Math.max(0, idx - 6), idx);
  return window.some((l) => l.toLowerCase().includes(headingWord));
}

function matchFirst(text: string, re: RegExp, group = 0): string | undefined {
  const m = text.match(re);
  return m ? m[group]?.trim() : undefined;
}

/**
 * Resolves structured project data for a WP content item: prefer populated
 * ACF fields, otherwise fetch and scrape the rendered page.
 */
export async function resolveProjectStructuredData(item: WPContentItem): Promise<ProjectStructuredData> {
  if (hasPopulatedAcf(item.acf)) {
    return extractFromAcf(item.acf as Record<string, unknown>);
  }
  const html = await fetchRenderedHtml(item.link);
  return extractStructuredDataFromHtml(html, item.link);
}

/**
 * Generic visible-text scrape for any rendered page, used as a fallback for
 * ANY post type (not just projects) when `content.rendered` from the REST
 * API is empty or near-empty. This happens for marketing pages built with a
 * page-builder (About, Our Philosophy, Investors, Sustainability, etc.) —
 * their actual content lives in shortcodes/widgets that the WP content
 * editor field never captures, so without this fallback those pages sync
 * with zero chunks despite being real, substantial pages on the live site.
 *
 * Deliberately simpler than extractStructuredDataFromHtml (no field
 * extraction) — just collects deduplicated heading/paragraph/list text,
 * since page-builder sections often repeat the same CTA text in multiple
 * places.
 */
export function extractGenericPageText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, noscript, header, form").remove();

  const seen = new Set<string>();
  const lines: string[] = [];
  $("body")
    .find("h1, h2, h3, h4, h5, h6, p, li")
    .each((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim().replace(/\s+/g, " ");
      if (!text || text.length < 3) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(text);
    });

  return lines.join("\n");
}

/** Fetches a page's rendered HTML and applies the generic text-scrape fallback above. */
export async function fetchGenericPageText(url: string): Promise<string> {
  const html = await fetchRenderedHtml(url);
  return extractGenericPageText(html);
}
