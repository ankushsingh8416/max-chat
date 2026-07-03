import { WP_API_BASE, WP_TYPE_DENYLIST } from "../constants";
import type { WPContentItem, WPPostType, WPTaxonomyTerm } from "./types";

async function fetchJson<T>(url: string, attempt = 1): Promise<{ data: T; headers: Headers }> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    if (res.status === 429 && attempt <= 4) {
      const wait = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      return fetchJson<T>(url, attempt + 1);
    }
    throw new Error(`WP REST request failed (${res.status}) for ${url}`);
  }
  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}

/** Discovers all content-bearing post types via /wp-json/wp/v2/types, minus known internal types. */
export async function discoverPostTypes(): Promise<WPPostType[]> {
  const { data } = await fetchJson<Record<string, WPPostType>>(`${WP_API_BASE}/types`);
  return Object.values(data).filter((t) => !WP_TYPE_DENYLIST.has(t.slug));
}

export async function fetchTaxonomyTerms(taxonomyRestBase: string): Promise<WPTaxonomyTerm[]> {
  const terms: WPTaxonomyTerm[] = [];
  let page = 1;
  for (;;) {
    const url = `${WP_API_BASE}/${taxonomyRestBase}?per_page=100&page=${page}`;
    const { data, headers } = await fetchJson<WPTaxonomyTerm[]>(url);
    terms.push(...data);
    const totalPages = Number(headers.get("X-WP-TotalPages") || "1");
    if (page >= totalPages) break;
    page += 1;
  }
  return terms;
}

export interface FetchContentOptions {
  /** ISO date string; only items modified after this will be returned. Omit for a full fetch. */
  modifiedAfter?: string;
}

/**
 * Fetches every item of a given REST base, following X-WP-TotalPages pagination
 * with per_page=100 (this is the superset of the site's public `?page_num=N`
 * blog pagination — the REST collection endpoint uses the standard `page` param).
 *
 * WordPress core does NOT support a `modified_after` collection filter out of
 * the box (only `after`/`before` on post_date via date_query) — some sites add
 * one via a plugin, so we still pass it in case it's honored, but we can't rely
 * on it. Instead, since results are requested `orderby=modified&order=desc`, we
 * filter client-side and stop paginating as soon as we see an item older than
 * the cutoff, which is correct regardless of server-side support.
 */
export async function fetchAllContent(
  restBase: string,
  opts: FetchContentOptions = {}
): Promise<WPContentItem[]> {
  const cutoff = opts.modifiedAfter ? Date.parse(opts.modifiedAfter) : undefined;
  const items: WPContentItem[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      per_page: "100",
      page: String(page),
      orderby: "modified",
      order: "desc",
      status: "publish",
    });
    if (opts.modifiedAfter) params.set("modified_after", opts.modifiedAfter);
    const url = `${WP_API_BASE}/${restBase}?${params.toString()}`;

    let result;
    try {
      result = await fetchJson<WPContentItem[]>(url);
    } catch (err) {
      // A 400 on page 1 for an empty/misconfigured endpoint shouldn't kill the whole sync.
      if (page === 1) {
        console.warn(`[wp-client] Failed to fetch ${restBase}: ${(err as Error).message}`);
        return items;
      }
      throw err;
    }

    if (cutoff !== undefined) {
      let hitOlder = false;
      for (const item of result.data) {
        if (Date.parse(item.modified_gmt) <= cutoff) {
          hitOlder = true;
          break;
        }
        items.push(item);
      }
      if (hitOlder) break;
    } else {
      items.push(...result.data);
    }

    const totalPages = Number(result.headers.get("X-WP-TotalPages") || "1");
    if (page >= totalPages || result.data.length === 0) break;
    page += 1;
  }
  return items;
}

/** Fetches the rendered HTML of a single published page, used for the ACF-scrape fallback. */
export async function fetchRenderedHtml(link: string): Promise<string> {
  const res = await fetch(link, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`Failed to fetch rendered page ${link} (${res.status})`);
  return res.text();
}
