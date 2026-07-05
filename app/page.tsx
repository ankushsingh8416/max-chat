import { ChatErrorBoundary } from "@/components/ChatErrorBoundary";
import { ChatWidget } from "@/components/ChatWidget";

export default function Home() {
  return (
    <>
      <main className="mx-auto flex max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold text-me-neutral-900">Max Estates Assistant</h1>
        {/* <p className="text-me-neutral-800">
          This is the backend and demo host for the Max Estates AI chat assistant. Open the chat
          bubble in the bottom-right corner to try it, or embed it on maxestates.in via{" "}
          <code className="rounded bg-me-neutral-100 px-1.5 py-0.5 text-sm">/widget</code> — see
          the README for setup and embedding instructions.
        </p> */}
      </main>
      <ChatErrorBoundary>
        <ChatWidget />
      </ChatErrorBoundary>
    </>
  );
}
