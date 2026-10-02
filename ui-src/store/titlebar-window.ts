// Shape of the window API injected by withGlobalTauri (the frontend does not install the
// @tauri-apps/api package).
// Referenced by the Window.__TAURI__ declaration in store/ws.ts; consumed by WindowControls.tsx.
export interface TauriWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}
