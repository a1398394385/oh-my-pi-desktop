import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// P1 基座：esbuild + 裸 JSX → Vite 8 + TS。
// root 定在 ui/（index.html 与图标注册表所在），源码入口在 ui-src/（Vite 默认可达 workspace 根）。
export default defineConfig({
  root: "ui",
  base: "./",
  // index.html 的 ../ui-src/main.tsx 在 build 由 rollup 按文件系统解析正常；
  // dev 则被规范化为 URL /ui-src/...（相对 root=ui 不存在）——alias 拉回仓库根，恢复浏览器直开调试
  resolve: {
    alias: {
      "/ui-src": fileURLToPath(new URL("./ui-src", import.meta.url)),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist", // 相对 root → ui/dist
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // 固定入口产物名，保持与旧 esbuild 一致的 assets/app.js（Tauri 与 smoke 都认这个路径）
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/chunk-[hash].js",
      },
    },
  },
});
