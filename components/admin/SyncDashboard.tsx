"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FileText, Link2, Loader2, RefreshCw, Search } from "lucide-react";

interface ContentStats {
  totalPages: number;
  totalChunks: number;
  byPostType: { postType: string; pages: number; chunks: number }[];
}

interface LatestSync {
  runAt: string;
  status: "success" | "partial" | "failed";
  pagesSynced: number;
  chunksCreated: number;
  errorCount: number;
}

interface SearchResult {
  sourceUrl: string;
  title: string;
  postType: string;
  chunkCount: number;
  lastModified: string | null;
}

function StatTile({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div className="rounded-xl bg-me-neutral-50 px-3 py-2.5">
      <p className={`truncate font-semibold text-me-neutral-900 ${small ? "text-sm" : "text-lg"}`}>{value}</p>
      <p className="text-xs text-me-neutral-800">{label}</p>
    </div>
  );
}

/**
 * Visibility and control over the RAG knowledge base: how much is indexed,
 * when it last synced, a way to search what's actually in there, a manual
 * "recrawl now" for the whole site, and a "sync a specific page" tool for
 * refreshing or adding one URL immediately without waiting for/running a
 * full re-sync. /admin's separate upload/train flow covers non-website
 * documents (PDFs/Word/text); this covers "the bot's view of the live site."
 */
export function SyncDashboard() {
  const [stats, setStats] = useState<ContentStats | null>(null);
  const [latestSync, setLatestSync] = useState<LatestSync | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const [pageUrl, setPageUrl] = useState("");
  const [isSyncingPage, setIsSyncingPage] = useState(false);
  const [pageSyncMessage, setPageSyncMessage] = useState("");
  const [pageSyncError, setPageSyncError] = useState("");

  const loadStats = useCallback(async () => {
    setIsLoadingStats(true);
    try {
      const res = await fetch("/api/admin/stats");
      const data = await res.json();
      setStats(data.contentStats ?? null);
      setLatestSync(data.latestSync ?? null);
    } finally {
      setIsLoadingStats(false);
    }
  }, []);

  useEffect(() => {
    // Standard fetch-on-mount — no cascading render loop, loadStats only
    // re-runs when explicitly called again (recrawl, search doesn't touch it).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStats();
  }, [loadStats]);

  async function handleRecrawl() {
    setIsSyncing(true);
    setSyncMessage("");
    try {
      const res = await fetch("/api/admin/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sync failed");
      setSyncMessage(`Done: ${data.pagesSynced} page(s) synced, ${data.chunksCreated} chunk(s) created.`);
      loadStats();
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch(`/api/admin/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data.results ?? []);
    } finally {
      setIsSearching(false);
    }
  }

  async function handleSyncPage(e: FormEvent) {
    e.preventDefault();
    if (!pageUrl.trim()) return;
    setIsSyncingPage(true);
    setPageSyncMessage("");
    setPageSyncError("");
    try {
      const res = await fetch("/api/admin/sync-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pageUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sync failed");
      setPageSyncMessage(
        data.changed
          ? `Updated "${data.title}" — ${data.chunkCount} chunk(s) saved.`
          : `"${data.title}" is already up to date (${data.chunkCount} chunk(s), no changes found).`
      );
      loadStats();
    } catch (err) {
      setPageSyncError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setIsSyncingPage(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-me-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-me-neutral-900">Knowledge base</h2>
        <button
          type="button"
          onClick={handleRecrawl}
          disabled={isSyncing}
          className="flex cursor-pointer items-center gap-1.5 rounded-full bg-me-primary-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-me-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} aria-hidden="true" />
          {isSyncing ? "Syncing..." : "Recrawl now"}
        </button>
      </div>

      {isLoadingStats ? (
        <p className="text-sm text-me-neutral-800">Loading...</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Pages indexed" value={stats?.totalPages ?? 0} />
            <StatTile label="Chunks" value={stats?.totalChunks ?? 0} />
            <StatTile
              label="Last sync"
              value={latestSync ? new Date(latestSync.runAt).toLocaleString() : "Never"}
              small
            />
            <StatTile label="Last sync status" value={latestSync?.status ?? "-"} small />
          </div>

          {stats && stats.byPostType.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs text-me-neutral-800">
              {stats.byPostType.map((p) => (
                <span key={p.postType} className="rounded-full bg-me-neutral-100 px-2.5 py-1">
                  {p.postType}: {p.pages} page{p.pages === 1 ? "" : "s"} / {p.chunks} chunk
                  {p.chunks === 1 ? "" : "s"}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {syncMessage && <p className="text-xs text-me-neutral-800">{syncMessage}</p>}

      <div className="border-t border-me-neutral-200 pt-4">
        <h3 className="mb-2 text-xs font-semibold text-me-neutral-900">Sync a specific page</h3>
        <p className="mb-2 text-xs text-me-neutral-800">
          Paste a maxestates.in page URL to scrape, chunk, and index it right now — useful for a page the
          scheduled sync hasn&apos;t reached yet, or to force-refresh one page immediately. Re-running this on
          the same URL only updates the knowledge base if the page&apos;s content actually changed.
        </p>
        <form onSubmit={handleSyncPage} className="flex gap-2">
          <input
            type="url"
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
            placeholder="https://maxestates.in/..."
            className="flex-1 rounded-xl border border-me-neutral-200 bg-me-neutral-50 px-3 py-2 text-sm text-me-neutral-900 outline-none focus:border-me-primary-400 focus:ring-1 focus:ring-me-primary-400"
          />
          <button
            type="submit"
            disabled={isSyncingPage || !pageUrl.trim()}
            className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-me-primary-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-me-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSyncingPage ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Link2 className="h-4 w-4" aria-hidden="true" />
            )}
            Sync
          </button>
        </form>
        {pageSyncMessage && <p className="mt-2 text-xs text-me-neutral-800">{pageSyncMessage}</p>}
        {pageSyncError && <p className="mt-2 text-xs text-red-600">{pageSyncError}</p>}
      </div>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search indexed content..."
          className="flex-1 rounded-xl border border-me-neutral-200 bg-me-neutral-50 px-3 py-2 text-sm text-me-neutral-900 outline-none focus:border-me-primary-400 focus:ring-1 focus:ring-me-primary-400"
        />
        <button
          type="submit"
          disabled={isSearching}
          aria-label="Search"
          className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-me-neutral-200 px-3 py-2 text-sm font-medium text-me-neutral-800 hover:bg-me-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>

      {searchResults !== null && (
        <div className="flex flex-col gap-1.5">
          {searchResults.length === 0 ? (
            <p className="text-sm text-me-neutral-800">No matches found.</p>
          ) : (
            searchResults.map((r) => (
              <a
                key={r.sourceUrl}
                href={r.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-xl border border-me-neutral-200 px-3 py-2 text-sm hover:bg-me-neutral-50"
              >
                <FileText className="h-4 w-4 shrink-0 text-me-neutral-800" aria-hidden="true" />
                <div className="flex-1 truncate">
                  <p className="truncate text-me-neutral-900">{r.title}</p>
                  <p className="text-xs text-me-neutral-800">
                    {r.postType} &middot; {r.chunkCount} chunk{r.chunkCount === 1 ? "" : "s"}
                  </p>
                </div>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}
