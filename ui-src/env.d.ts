/// <reference types="vite/client" />

// preview 调试钩子（main.jsx preview 模式注入），类型输入之一
declare global {
  interface Window {
    __dbg?: Record<string, unknown>;
  }
}

export {};
