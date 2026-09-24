// 全局错误边界：任何渲染期异常兜底为可见错误页，而不是整窗口黑屏（BUG-014 同款根因：
// 无边界时 React 根容器被卸载，深色主题下就是「应用黑掉」，现场与报错一起丢失）。
// 边界页展示错误信息 + 一键重载；错误同时打上控制台标记便于 DevTools 翻查。
import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stack: "" };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ stack: info?.componentStack || "" });
    console.error("[ui] 渲染崩溃（已被边界捕获）:", error, info?.componentStack);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const msg = String(error?.message ?? error);
    return (
      <div id="errBoundary" style={{ padding: 32, fontFamily: "var(--sans)", color: "var(--text)" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>界面渲染出错（已拦截黑屏）</h2>
        <pre style={{ whiteSpace: "pre-wrap", color: "var(--err)", fontSize: 13, maxHeight: "30vh", overflow: "auto" }}>{msg}</pre>
        {stack ? (
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--dim)", fontSize: 12, maxHeight: "40vh", overflow: "auto", marginTop: 12 }}>{stack}</pre>
        ) : null}
        <button
          className="confirm-btn"
          style={{ marginTop: 16 }}
          onClick={() => location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }
}
