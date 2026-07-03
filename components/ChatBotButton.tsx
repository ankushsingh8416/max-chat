"use client";

import { Bot, X } from "lucide-react";
import { forwardRef } from "react";

interface ChatBotButtonProps {
  isOpen: boolean;
  onClick: () => void;
  hasUnread?: boolean;
}

export const ChatBotButton = forwardRef<HTMLButtonElement, ChatBotButtonProps>(
  function ChatBotButton({ isOpen, onClick, hasUnread }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={isOpen ? "Close chat with Max Estates Assistant" : "Chat with Max Estates Assistant"}
        aria-expanded={isOpen}
        aria-controls="max-estates-chat-panel"
        className={`group relative flex h-14 w-14 items-center justify-center rounded-full bg-me-terracotta-500 text-white shadow-lg shadow-me-terracotta-900/20 transition-transform duration-200 hover:scale-105 hover:bg-me-terracotta-600 focus:outline-none focus-visible:ring-4 focus-visible:ring-me-terracotta-300 ${
          isOpen ? "" : "animate-me-pulse-glow"
        }`}
      >
        {!isOpen && hasUnread && (
          <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-me-terracotta-700 ring-2 ring-white" />
        )}
        <span className="relative flex h-6 w-6 items-center justify-center">
          <Bot
            className={`absolute h-6 w-6 transition-all duration-200 ${
              isOpen ? "scale-0 opacity-0" : "scale-100 opacity-100"
            }`}
          />
          <X
            className={`absolute h-6 w-6 transition-all duration-200 ${
              isOpen ? "scale-100 opacity-100" : "scale-0 opacity-0"
            }`}
          />
        </span>
      </button>
    );
  }
);
