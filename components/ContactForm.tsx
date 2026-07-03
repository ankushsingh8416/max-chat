"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

interface ContactFormProps {
  onCancel: () => void;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

const inputClassName =
  "rounded-xl border border-me-neutral-200 bg-me-neutral-50 px-3 py-2 text-sm text-me-neutral-900 outline-none focus:border-me-terracotta-400 focus:ring-1 focus:ring-me-terracotta-400";

export function ContactForm({ onCancel }: ContactFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const isSubmitting = state === "submitting";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setState("submitting");
    setErrorMessage("");

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
      setState("success");
    } catch (err) {
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  if (state === "success") {
    return (
      <div className="flex items-center gap-3 border-t border-me-neutral-200 bg-white p-4 sm:rounded-b-2xl">
        <CheckCircle2 className="h-8 w-8 shrink-0 text-green-600" aria-hidden="true" />
        <div className="flex-1">
          <p className="text-sm font-medium text-me-neutral-900">Thank you! We&apos;ve received your message.</p>
          <p className="text-xs text-me-neutral-800">Our team will get back to you shortly.</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-full bg-me-terracotta-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-me-terracotta-600"
        >
          Back to chat
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex max-h-80 flex-col gap-2.5 overflow-y-auto border-t border-me-neutral-200 bg-white p-3.5 sm:rounded-b-2xl"
    >
      <p className="text-xs text-me-neutral-800">Leave your details and our team will get back to you.</p>

      <label className="flex flex-col gap-1 text-xs font-medium text-me-neutral-800">
        Name
        <input
          type="text"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          className={inputClassName}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-me-neutral-800">
        Email
        <input
          type="email"
          required
          maxLength={200}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className={inputClassName}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-me-neutral-800">
        Phone number
        <input
          type="tel"
          required
          maxLength={20}
          pattern="[0-9+\-\s()]{7,20}"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          className={inputClassName}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-me-neutral-800">
        Message
        <textarea
          required
          maxLength={2000}
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="How can we help you?"
          className={`resize-none ${inputClassName}`}
        />
      </label>

      {state === "error" && <p className="text-xs text-red-600">{errorMessage}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="flex-1 rounded-full border border-me-neutral-200 px-4 py-2 text-sm font-medium text-me-neutral-800 transition-colors hover:bg-me-neutral-50 disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-me-terracotta-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-me-terracotta-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Submit
        </button>
      </div>
    </form>
  );
}
