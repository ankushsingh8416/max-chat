export interface WPRendered {
  rendered: string;
  protected?: boolean;
}

export interface WPPostType {
  slug: string;
  rest_base: string;
  name: string;
  description?: string;
}

/**
 * Shape of a single item returned from any WP REST content endpoint
 * (posts, pages, or a custom post type). `acf` is present only when the
 * "ACF to REST API" plugin (or ACF's built-in REST support) is active on
 * that post type; when absent or an empty array/object, callers must fall
 * back to scraping the rendered page.
 */
export interface WPContentItem {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  modified_gmt: string;
  slug: string;
  status: string;
  type: string;
  link: string;
  title: WPRendered;
  content: WPRendered;
  excerpt?: WPRendered;
  featured_media?: number;
  categories?: number[];
  tags?: number[];
  acf?: Record<string, unknown> | unknown[];
  [key: string]: unknown;
}

export interface WPTaxonomyTerm {
  id: number;
  name: string;
  slug: string;
  taxonomy: string;
}

/** Structured data extracted for a real-estate project, whether sourced from ACF or scraped HTML. */
export interface ProjectStructuredData {
  price?: string;
  location?: string;
  rera?: string;
  possession_date?: string;
  configurations?: string[];
  area_range?: string;
  amenities?: string[];
  category?: string; // e.g. "residential", "commercial"
  source: "acf" | "scrape";
  fields_missing: string[];
}
