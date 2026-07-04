"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileText, Loader2, Trash2, UploadCloud, XCircle } from "lucide-react";

const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt"];

interface DocSummary {
  sourceUrl: string;
  title: string;
  uploadedAt: string;
  chunkCount: number;
}

interface UploadJob {
  id: string;
  filename: string;
  status: "uploading" | "done" | "error";
  error?: string;
}

function isAcceptedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function UploadDashboard() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState(true);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDocs = useCallback(async () => {
    setIsLoadingDocs(true);
    try {
      const res = await fetch("/api/admin/docs");
      if (res.status === 401) {
        router.refresh();
        return;
      }
      const data = await res.json();
      setDocs(data.docs ?? []);
    } finally {
      setIsLoadingDocs(false);
    }
  }, [router]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const uploadFile = useCallback(
    async (file: File) => {
      const jobId = `${file.name}-${crypto.randomUUID()}`;
      setJobs((prev) => [...prev, { id: jobId, filename: file.name, status: "uploading" }]);

      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/admin/upload", { method: "POST", body: formData });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Upload failed");

        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: "done" } : j)));
        loadDocs();
      } catch (err) {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId
              ? { ...j, status: "error", error: err instanceof Error ? err.message : "Upload failed" }
              : j
          )
        );
      }
    },
    [loadDocs]
  );

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      Array.from(fileList).forEach((file) => {
        if (!isAcceptedFile(file.name)) {
          setJobs((prev) => [
            ...prev,
            { id: crypto.randomUUID(), filename: file.name, status: "error", error: "Unsupported file type" },
          ]);
          return;
        }
        uploadFile(file);
      });
    },
    [uploadFile]
  );

  async function handleDelete(sourceUrl: string) {
    setDeletingUrl(sourceUrl);
    try {
      await fetch(`/api/admin/docs/${encodeURIComponent(sourceUrl)}`, { method: "DELETE" });
      setDocs((prev) => prev.filter((d) => d.sourceUrl !== sourceUrl));
    } finally {
      setDeletingUrl(null);
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleLogout}
          className="text-xs font-medium text-me-neutral-800 underline underline-offset-2 hover:text-me-neutral-900"
        >
          Sign out
        </button>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          isDragging
            ? "border-me-terracotta-400 bg-me-terracotta-50"
            : "border-me-neutral-200 bg-white hover:bg-me-neutral-50"
        }`}
      >
        <UploadCloud className="h-8 w-8 text-me-terracotta-500" aria-hidden="true" />
        <p className="text-sm font-medium text-me-neutral-900">Drag and drop documents here, or click to browse</p>
        <p className="text-xs text-me-neutral-800">Supports PDF, Word (.docx), and plain text (.txt)</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {jobs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center gap-2 rounded-xl border border-me-neutral-200 bg-white px-3 py-2 text-sm"
            >
              {job.status === "uploading" && (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-me-terracotta-500" aria-hidden="true" />
              )}
              {job.status === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />}
              {job.status === "error" && <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />}
              <span className="flex-1 truncate text-me-neutral-900">{job.filename}</span>
              {job.status === "error" && <span className="text-xs text-red-600">{job.error}</span>}
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-me-neutral-900">Trained documents</h2>
        {isLoadingDocs ? (
          <p className="text-sm text-me-neutral-800">Loading...</p>
        ) : docs.length === 0 ? (
          <p className="text-sm text-me-neutral-800">No documents uploaded yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {docs.map((doc) => (
              <div
                key={doc.sourceUrl}
                className="flex items-center gap-2 rounded-xl border border-me-neutral-200 bg-white px-3 py-2 text-sm"
              >
                <FileText className="h-4 w-4 shrink-0 text-me-neutral-800" aria-hidden="true" />
                <div className="flex-1 truncate">
                  <p className="truncate text-me-neutral-900">{doc.title}</p>
                  <p className="text-xs text-me-neutral-800">
                    {doc.chunkCount} chunk{doc.chunkCount === 1 ? "" : "s"} &middot;{" "}
                    {new Date(doc.uploadedAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(doc.sourceUrl)}
                  disabled={deletingUrl === doc.sourceUrl}
                  aria-label={`Remove ${doc.title}`}
                  className="shrink-0 rounded-full p-1.5 text-me-neutral-800 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  {deletingUrl === doc.sourceUrl ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
