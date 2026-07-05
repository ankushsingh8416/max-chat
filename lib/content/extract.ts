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

/** Keys worth pulling out of JSON-LD structured data — org/person/article facts that often never appear as visible page text at all. */
const JSONLD_INTERESTING_KEYS = [
  "name", "jobTitle", "description", "headline", "author", "datePublished",
  "dateModified", "address", "telephone", "email", "url",
];

function flattenJsonLd(data: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (Array.isArray(data)) {
    return data.map((d) => flattenJsonLd(d, depth + 1)).filter(Boolean).join("; ");
  }
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (obj["@graph"]) return flattenJsonLd(obj["@graph"], depth + 1);
    const parts: string[] = [];
    for (const key of JSONLD_INTERESTING_KEYS) {
      const v = obj[key];
      if (v === undefined || v === null) continue;
      const nested = typeof v === "string" ? v : flattenJsonLd(v, depth + 1);
      if (nested) parts.push(`${key}: ${nested}`);
    }
    return parts.join(", ");
  }
  return "";
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
 * Includes `div`/`span`/`a` alongside headings/paragraphs/list items —
 * confirmed directly that page-builder "card" layouts (e.g. the
 * leadership-team page's team-member grid) render text like a person's name
 * as bare `<div class="name">Sanjeev Ailawadi</div>`, with no heading or `<p>`
 * wrapper at all, which the original heading/paragraph/list-only selector
 * silently missed entirely. Safe to include structural tags like `div`
 * because `.clone().children().remove().end().text()` only keeps an
 * element's OWN direct text — a wrapping `<div>` around other elements has no
 * direct text of its own once its children are stripped, so it contributes
 * nothing and is filtered out by the length check below; only genuine
 * text-bearing leaf nodes survive.
 *
 * Also pulls in content a plain visible-text scrape would otherwise miss
 * entirely: table rows (kept as `cell | cell` so structure survives, rather
 * than losing row alignment by scraping cells individually), OpenGraph/meta
 * description, breadcrumb trails (extracted by class name before the general
 * `nav` removal below, so real navigation menus still get stripped without
 * also losing breadcrumb context), JSON-LD structured data, and image alt
 * text (which occasionally carries real info, like a person's name, with no
 * visible caption alongside it).
 */
export function extractGenericPageText(html: string): string {
  const $ = cheerio.load(html);

  const metaLines: string[] = [];
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDescription =
    $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content");
  if (ogTitle) metaLines.push(`Page title: ${ogTitle}`);
  if (ogDescription) metaLines.push(`Page description: ${ogDescription}`);

  const breadcrumbText = $('[class*="breadcrumb"]').first().text().trim().replace(/\s+/g, " ");
  if (breadcrumbText && breadcrumbText.length < 300) metaLines.push(`Breadcrumb: ${breadcrumbText}`);

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const flat = flattenJsonLd(JSON.parse($(el).text()));
      if (flat) metaLines.push(`Structured data: ${flat}`);
    } catch {
      // Malformed JSON-LD shouldn't fail the whole page's extraction.
    }
  });

  $("script, style, nav, footer, noscript, header, form, svg").remove();

  const seen = new Set<string>();
  const lines: string[] = [...metaLines];
  metaLines.forEach((line) => seen.add(line.toLowerCase()));

  $("body")
    .find("h1, h2, h3, h4, h5, h6, p, li, div, span, a, summary")
    .each((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim().replace(/\s+/g, " ");
      if (!text || text.length < 3) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(text);
    });

  $("table").each((_, table) => {
    $(table)
      .find("tr")
      .each((_, tr) => {
        const cells = $(tr)
          .find("td, th")
          .map((_, cell) => $(cell).text().trim().replace(/\s+/g, " "))
          .get()
          .filter(Boolean);
        if (cells.length === 0) return;
        const rowText = cells.join(" | ");
        const key = rowText.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(rowText);
      });
  });

  $("img[alt]").each((_, img) => {
    const alt = $(img).attr("alt")?.trim();
    if (!alt || alt.length < 4) return;
    const key = alt.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(alt);
  });

  return lines.join("\n");
}

/** Fetches a page's rendered HTML and applies the generic text-scrape fallback above. */
export async function fetchGenericPageText(url: string): Promise<string> {
  const html = await fetchRenderedHtml(url);
  return extractGenericPageText(html);
}
