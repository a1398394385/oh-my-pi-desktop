// Global error boundary: any render-phase exception falls back to a visible error page
// instead of the whole window going black (same root cause as BUG-014: without a boundary the
// React root container unmounts — under the dark theme that's "the app went black", losing
// both the scene and the error).
// The boundary page shows the error + one-click reload; the error is also logged to the
// console for DevTools inspection.
import { Component, type ReactNode, type ErrorInfo } from "react";
import { t } from "../i18n";

interface Props {
  children?: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, stack: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error, stack: "" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info?.componentStack || "" });
    console.error("[ui] 渲染崩溃（已被边界捕获）:", error, info?.componentStack);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const msg = String(error?.message ?? error);
    return (
      <div id="errBoundary" style={{ padding: 32, fontFamily: "var(--sans)", color: "var(--text)" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>{t("misc.renderError")}</h2>
        <pre style={{ whiteSpace: "pre-wrap", color: "var(--err)", fontSize: 13, maxHeight: "30vh", overflow: "auto" }}>{msg}</pre>
        {stack ? (
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--dim)", fontSize: 12, maxHeight: "40vh", overflow: "auto", marginTop: 12 }}>{stack}</pre>
        ) : null}
        <button
          className="confirm-btn"
          style={{ marginTop: 16 }}
          onClick={() => location.reload()}
        >
          {t("misc.reload")}
        </button>
      </div>
    );
  }
}
