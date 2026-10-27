/**
 * Keeps a render error in one region from unmounting the whole add-in (which
 * shows up as a blank page inside MyGeotab). The error and stack are shown
 * in a Zenith banner and logged, so the next report is actionable.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Banner, Button } from "@geotab/zenith";

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[MWO] Render error in ${this.props.label}:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Banner type="error" header={`Something went wrong rendering the ${this.props.label}`}>
          <div className="mwo-error">
            <code>{String(this.state.error?.message ?? this.state.error)}</code>
            <pre>{(this.state.error?.stack ?? "").split("\n").slice(0, 6).join("\n")}</pre>
            <Button type="secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          </div>
        </Banner>
      );
    }
    return this.props.children;
  }
}
