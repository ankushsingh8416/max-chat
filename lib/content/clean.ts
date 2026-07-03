import { htmlToText } from "html-to-text";

/**
 * Converts WP rendered HTML to plain text while keeping heading context as
 * markdown-style `#` markers, so a chunker downstream can still tell which
 * section a paragraph belongs to even after the HTML is gone.
 */
export function cleanHtmlToText(html: string): string {
  if (!html) return "";
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((tag) => ({
        selector: tag,
        options: { uppercase: false },
      })),
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
