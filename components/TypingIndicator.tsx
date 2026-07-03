export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-3.5 py-2.5" role="status" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-me-neutral-800/40 animate-me-bounce-dot"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
