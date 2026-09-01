import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportToMain } from "../../lib/diag";

interface Props {
  children: ReactNode;
}

interface State {
  crashed: boolean;
}

/** Last-resort boundary around the whole app. Two jobs, both diagnostic:
 *  forward the error and its component stack to main (so the diag log can tell
 *  a React crash apart from a dead render process), and paint a visible
 *  fallback so a component crash never looks like the blank-screen bug we are
 *  chasing. Not a recovery mechanism -- a reload is still required. */
export class DiagErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportToMain({
      kind: "react-boundary",
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-8 text-center text-sm text-muted-foreground">
        <div className="max-w-sm">
          <p className="font-medium text-foreground">Something went wrong.</p>
          <p className="mt-1">
            The interface hit an error and needs a reload. Details were written to the diagnostics log.
          </p>
        </div>
      </div>
    );
  }
}
