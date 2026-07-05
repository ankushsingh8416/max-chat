"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, Send, User, X } from "lucide-react";
import { ChatBotButton } from "./ChatBotButton";
import { ContactForm } from "./ContactForm";
import { MarkdownMessage } from "./MarkdownMessage";
import { TypingIndicator } from "./TypingIndicator";
import { postToParent } from "@/lib/embed-bridge";

const SESSION_STORAGE_KEY = "max-estates-chat-messages";

const STARTER_PROMPTS = [
  "Show me residential projects in Noida",
  "What's the price of The Terraces?",
  "Latest news from Max Estates",
  "Commercial projects in Gurugram",
];

/**
 * True when the model itself decided (via the suggestContactForm tool, see
 * lib/tools.ts and the system prompt in lib/rag.ts) that this conversation
 * needs human follow-up — rather than the client guessing from fixed text
 * patterns in the reply, which breaks the moment the model phrases things
 * differently (e.g. in Hindi/Hinglish).
 */
function hasContactFormToolCall(message: UIMessage): boolean {
  return message.parts.some((p) => p.type === "tool-suggestContactForm");
}

function loadStoredMessages(): UIMessage[] | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UIMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

function hasTextContent(message: UIMessage): boolean {
  return message.parts.some((p) => p.type === "text" && p.text.trim().length > 0);
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Reveals `text` word-by-word over a short, length-capped duration rather than
 * all at once, when `active`. Chat generation is fully buffered server-side
 * (see lib/openai/chat-failover.ts — needed so a failed key can be retried
 * before anything reaches the client), so the client never gets real
 * token-by-token streaming to animate; this simulates the same "typing"
 * feel purely client-side once the final text is known.
 */
function useTypewriter(text: string, active: boolean, onDone?: () => void): string {
  const [display, setDisplay] = useState("");
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (!active || !text) return;

    const tokens = text.match(/\S+\s*/g) ?? [text];
    const TICK_MS = 30;
    const MAX_DURATION_MS = 1000; // cap so long replies don't feel slow to read
    const tokensPerTick = Math.max(1, Math.ceil(tokens.length / (MAX_DURATION_MS / TICK_MS)));

    let i = 0;
    const id = setInterval(() => {
      i += tokensPerTick;
      setDisplay(tokens.slice(0, i).join(""));
      if (i >= tokens.length) {
        clearInterval(id);
        onDoneRef.current?.();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [text, active]);

  return active ? display : text;
}

interface MessageBubbleProps {
  message: UIMessage;
  animate: boolean;
  onAnimationDone: () => void;
}

function MessageBubble({ message, animate, onAnimationDone }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const text = messageText(message);
  const displayText = useTypewriter(text, animate && !isUser, onAnimationDone);
  if (!text) return null;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm ${
          isUser
            ? "rounded-tr-sm bg-me-primary-500 text-white"
            : "rounded-tl-sm bg-white text-me-neutral-900"
        }`}
      >
        {isUser ? <p className="whitespace-pre-wrap">{text}</p> : <MarkdownMessage content={displayText} />}
      </div>
    </div>
  );
}

interface ChatWidgetProps {
  /**
   * True when rendered inside the /widget iframe route embedded on the
   * WordPress site. Swaps fixed-viewport positioning for "fill the iframe"
   * sizing, and notifies the parent page (public/embed.js) to resize that
   * iframe on open/close via postMessage.
   */
  embedded?: boolean;
}

export function ChatWidget({ embedded = false }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [hasUnread, setHasUnread] = useState(false);
  const [initialMessages] = useState(loadStoredMessages);
  const [showContactForm, setShowContactForm] = useState(false);
  const [animatingMessageId, setAnimatingMessageId] = useState<string | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isOpenRef = useRef(isOpen);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  const { messages, sendMessage, status } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onFinish: ({ message }) => {
      if (!isOpenRef.current) setHasUnread(true);
      if (hasContactFormToolCall(message)) setShowContactForm(true);
      setAnimatingMessageId(message.id);
    },
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // sessionStorage can throw in private-browsing/quota-exceeded edge cases; losing
      // persistence is an acceptable degradation, the chat itself keeps working.
    }
  }, [messages]);


  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [isOpen]);

  const lastMessage = messages[messages.length - 1];

  const closeChat = useCallback(() => {
    setIsOpen(false);
    buttonRef.current?.focus();
    if (embedded) postToParent("close");
  }, [embedded]);

  const openChat = useCallback(() => {
    setIsOpen(true);
    setHasUnread(false);
    if (embedded) postToParent("open");
  }, [embedded]);

  const toggle = useCallback(() => (isOpen ? closeChat() : openChat()), [isOpen, closeChat, openChat]);

  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 150);
    return () => clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeChat();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, closeChat]);

  const isBusy = status === "submitted" || status === "streaming";

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isBusy || trimmed.length > 2000) return;
      sendMessage({ text: trimmed });
      setInput("");
    },
    [isBusy, sendMessage]
  );

  const showTyping = isBusy && (!lastMessage || lastMessage.role !== "assistant" || !hasTextContent(lastMessage));

  const rootClassName = embedded
    ? "flex h-full w-full flex-col items-end justify-end"
    : "fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-3 sm:bottom-6 sm:right-6";

  const panelClassName = embedded
    ? "flex h-full w-full animate-me-fade-in flex-col overflow-hidden bg-white"
    : "fixed inset-0 flex h-[100dvh] w-screen animate-me-fade-in flex-col overflow-hidden bg-white shadow-2xl ring-1 ring-black/5 sm:static sm:h-[600px] sm:w-[400px] sm:rounded-2xl";

  return (
    <div className={rootClassName}>
      {isOpen && (
        <div
          ref={panelRef}
          id="max-estates-chat-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Max Estates Assistant chat"
          className={panelClassName}
        >
          <div className="relative z-10 flex items-center justify-between gap-3 bg-me-primary-500 px-4 py-3.5 text-white shadow-md sm:rounded-t-2xl">
            <div className="flex items-center gap-3">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-inset ring-white/25">
                <User className="h-5 w-5" aria-hidden="true" />
                <span
                  className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-me-primary-500"
                  aria-hidden="true"
                />
              </div>
              <div>
                <p className="text-sm font-semibold tracking-tight leading-tight">Max Estates Assistant</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs leading-tight text-white/75">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                  Online &middot; Replies instantly
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {!showContactForm && (
                <button
                  type="button"
                  onClick={() => setShowContactForm(true)}
                  aria-label="Contact us"
                  title="Contact us"
                  className="cursor-pointer rounded-full p-1.5 hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <Phone className="h-5 w-5" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={closeChat}
                aria-label="Close chat"
                className="cursor-pointer rounded-full p-1.5 hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="me-scrollbar-thin flex-1 overflow-y-auto bg-me-neutral-50" aria-live="polite">
            <div ref={messagesContentRef} className="space-y-3 px-3.5 py-4">
              {messages.length === 0 && (
                <div className="flex flex-col gap-3">
                  <div className="w-fit max-w-[85%] rounded-2xl rounded-tl-sm bg-white px-3.5 py-2.5 text-sm text-me-neutral-800 shadow-sm">
                    Hi! I&apos;m the Max Estates assistant. Ask me about our residential and commercial
                    projects, pricing, locations, or the latest news.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {STARTER_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => submit(prompt)}
                        className="cursor-pointer rounded-full border border-me-primary-200 bg-white px-3 py-1.5 text-xs font-medium text-me-primary-700 transition-colors hover:bg-me-primary-50"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  animate={message.id === animatingMessageId}
                  onAnimationDone={() =>
                    setAnimatingMessageId((current) => (current === message.id ? null : current))
                  }
                />
              ))}

              {showTyping && (
                <div className="w-fit max-w-[85%] rounded-2xl rounded-tl-sm bg-white shadow-sm">
                  <TypingIndicator />
                </div>
              )}

              {status === "error" && (
                <div className="rounded-2xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                  Something went wrong on our end. Please try again in a moment.
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {showContactForm ? (
            <ContactForm onCancel={() => setShowContactForm(false)} />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(input);
              }}
              className="flex items-end gap-2 border-t border-me-neutral-200 bg-white p-3 sm:rounded-b-2xl"
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(input);
                  }
                }}
                rows={1}
                maxLength={2000}
                placeholder="Ask about a project, price, location..."
                aria-label="Type your message"
                className="max-h-24 flex-1 resize-none rounded-xl border border-me-neutral-200 bg-me-neutral-50 px-3 py-2 text-sm text-me-neutral-900 outline-none focus:border-me-primary-400 focus:ring-1 focus:ring-me-primary-400"
              />
              <button
                type="submit"
                disabled={!input.trim() || isBusy}
                aria-label="Send message"
                className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-me-primary-500 text-white transition-colors hover:bg-me-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </button>
            </form>
          )}
        </div>
      )}

      {!isOpen && <ChatBotButton ref={buttonRef} isOpen={isOpen} onClick={toggle} hasUnread={hasUnread} />}
    </div>
  );
}
