// Windows 自绘标题栏（VSCode 风格）：tauri.windows.conf.json 中 decorations:false 后，
// 由本组件提供拖动区与最小化/最大化/关闭按钮；macOS 走系统 Overlay + 红绿灯，不渲染。
// 拖动与双击最大化由 data-tauri-drag-region 交 Tauri 内核处理（权限见 capabilities/default.json）。
import { useEffect, useState } from "react";
import { IS_WINDOWS } from "../platform";

export { IS_WINDOWS };

// withGlobalTauri 注入的窗口 API（前端不装 @tauri-apps/api 包）。
// __TAURI__ 的全局声明见 store/ws.ts（window 命名空间类型为 ./titlebar-window）
import type { TauriWindow } from "../store/titlebar-window";

function win(): TauriWindow {
  // 浏览器直连调试（?preview=1，无 Tauri 注入）时窗口控制无意义，no-op 保持可渲染
  return window.__TAURI__?.window?.getCurrentWindow() ?? {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
  };
}

function MinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaxIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    document.body.classList.add("has-titlebar");
    const w = win();
    let unlisten: (() => void) | undefined;
    void w.isMaximized().then(setMaximized);
    void w.onResized(() => {
      void w.isMaximized().then(setMaximized);
    }).then((fn) => { unlisten = fn; });
    return () => {
      document.body.classList.remove("has-titlebar");
      unlisten?.();
    };
  }, []);
  return (
    <div className="app-titlebar" data-tauri-drag-region="">
      <span className="titlebar-title" data-tauri-drag-region="">omp desktop</span>
      <div className="titlebar-btns">
        <button type="button" className="titlebar-btn" title="最小化" onClick={() => void win().minimize()}>
          <MinIcon />
        </button>
        <button type="button" className="titlebar-btn" title={maximized ? "向下还原" : "最大化"} onClick={() => void win().toggleMaximize()}>
          {maximized ? <RestoreIcon /> : <MaxIcon />}
        </button>
        <button type="button" className="titlebar-btn titlebar-close" title="关闭" onClick={() => void win().close()}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
