// Forwarding shim: the WS frame contract's single source of truth moved to
// host/wire/ (A10) — pure types, zero runtime imports, so tsc/vite consume it
// across the ui-src/host directory split. Every historical frames.ts symbol
// re-exports unchanged; import from here exactly as before.
export * from "../../host/wire";
export * from "../../host/wire/requests";
