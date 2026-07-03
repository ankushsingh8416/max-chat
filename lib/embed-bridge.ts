/**
 * Lightweight postMessage bridge so the chat widget, when embedded on the
 * WordPress site via an <iframe src="https://<vercel-app>/widget">, can ask
 * the parent page (running public/embed.js) to resize that iframe between a
 * small closed "bubble" size and a full chat-panel size. Same-origin
 * embedding (e.g. testing the widget on this app's own pages) never needs
 * this — it's a no-op there since nothing listens for the message.
 */
export const EMBED_MESSAGE_SOURCE = "max-estates-chat";

export type EmbedMessageType = "open" | "close";

export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true; // a cross-origin parent throws on access, which itself implies framing
  }
}

export function postToParent(type: EmbedMessageType): void {
  if (typeof window === "undefined" || !isEmbedded()) return;
  window.parent.postMessage({ source: EMBED_MESSAGE_SOURCE, type }, "*");
}
