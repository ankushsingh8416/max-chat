import type { Metadata } from "next";
import { ChatErrorBoundary } from "@/components/ChatErrorBoundary";
import { ChatWidget } from "@/components/ChatWidget";

export const metadata: Metadata = {
  title: "Max Estates Assistant",
  robots: { index: false, follow: false },
};

/**
 * Bare host page for the chat widget, meant to be loaded inside an <iframe>
 * on the WordPress site (see public/embed.js). Renders only the widget —
 * no site chrome — with a transparent, fully-clickable-through background so
 * only the button/panel itself is visible.
 */
export default function WidgetPage() {
  return (
    <div className="h-dvh w-screen bg-transparent">
      <ChatErrorBoundary>
        <ChatWidget embedded />
      </ChatErrorBoundary>
    </div>
  );
}
