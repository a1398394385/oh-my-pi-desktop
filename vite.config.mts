import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// P1 base: esbuild + bare JSX -> Vite 8 + TS.
// root is ui/ (where index.html and the icon registries live); the source entry is ui-src/
// (Vite can still reach the workspace root by default).
export default defineConfig({
  root: "ui",
  base: "./",
  // In build, rollup resolves index.html's ../ui-src/main.tsx via the file system fine;
  // in dev it gets normalized to the URL /ui-src/... (nonexistent relative to root=ui) —
  // the alias pulls it back to the repo root, restoring open-in-browser debugging
  resolve: {
    alias: {
      "/ui-src": fileURLToPath(new URL("./ui-src", import.meta.url)),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist", // relative to root -> ui/dist
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // Desktop assets load via the local asset protocol, never the network: the entry
    // bundles heavy deps like shiki/lexical/xterm (~5.2MB output), so there is no network
    // chunking — silence the 500kB size hint (adjust this when the entry size changes)
    chunkSizeWarningLimit: 6000,
    rolldownOptions: {
      output: {
        // Fixed entry artifact name, keeping assets/app.js from the old esbuild build
        // (both Tauri and smoke expect this path)
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/chunk-[hash].js",
      },
    },
  },
});
