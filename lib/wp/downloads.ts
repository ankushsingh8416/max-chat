import * as cheerio from "cheerio";
import { WP_BASE_URL } from "../constants";

export interface DownloadLink {
  title: string;
  url: string;
}

/**
 * Scrapes https://maxestates.in/downloads for PDF links (brochures,
 * sustainability reports, statutory clearances) — these are static files the
 * WordPress REST API has no visibility into at all, so this page is the only
 * way to discover them. Each card on the page is `<li><div class="container">
 * <ul><li>Title</li><li><a href=".pdf">Open</a></li><li><a href=".pdf"
 * download>Download</a></li></ul></div></li>` — both links point at the same
 * file, so results are deduplicated by URL.
 */
export async function discoverDownloadLinks(): Promise<DownloadLink[]> {
  const res = await fetch(`${WP_BASE_URL}/downloads`);
  if (!res.ok) throw new Error(`Failed to fetch downloads page (${res.status})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const seen = new Map<string, string>();

  $(".grid > ul > li").each((_, card) => {
    const $card = $(card);
    const pdfLink = $card.find('a[href$=".pdf"]').first();
    const href = pdfLink.attr("href");
    if (!href) return;

    const url = new URL(href, WP_BASE_URL).toString();
    if (seen.has(url)) return;

    const titleLi = $card.find("ul li").filter((__, el) => $(el).find("a").length === 0).first();
    const title = titleLi.text().trim() || decodeURIComponent(url.split("/").pop() || url);

    seen.set(url, title);
  });

  return Array.from(seen.entries()).map(([url, title]) => ({ url, title }));
}
