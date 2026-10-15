/// <reference types="vite/client" />

// Preview debug hook (injected by main.jsx in preview mode), one of the type inputs
declare global {
  interface Window {
    __dbg?: Record<string, unknown>;
  }
}

export {};
