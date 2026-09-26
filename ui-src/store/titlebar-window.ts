// withGlobalTauri 注入的窗口 API 形状（前端不装 @tauri-apps/api 包）。
// 被 store/ws.ts 的 Window.__TAURI__ 声明引用；TitleBar.tsx 消费。
export interface TauriWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}
