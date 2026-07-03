"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Isolates the chat widget so a runtime error inside it (bad API response,
 * a rendering bug, etc.) never takes down the rest of the site. On error we
 * simply render nothing rather than a visible fallback — the chat is an
 * enhancement, not core page content, so failing silently is the safer UX.
 */
export class ChatErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error("[ChatWidget] crashed and was unmounted:", error, info);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
