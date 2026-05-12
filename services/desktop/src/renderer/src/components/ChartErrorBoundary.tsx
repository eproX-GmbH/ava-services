// C1 — Error-Boundary für `ChatChart`.
//
// Fängt Render-Time-Exceptions (z. B. ein NaN, das durchs Schema gerutscht
// ist) und zeigt stattdessen die roh-JSON-Vorschau, damit der Nutzer
// niemals ein kaputtes oder leeres Diagramm sieht.

import { Component, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ChartErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.warn("[chart] Render-Time-Exception abgefangen:", error);
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
