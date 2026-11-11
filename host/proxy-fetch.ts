// Routes the process-wide fetch through PI_PROXY (the desktop proxy setting).
//
// The SDK only wraps the global fetch in its CLI entry (cli.ts); a desktop host
// boots through host.ts, so provider-bound bare fetches — OAuth login and token
// refresh, usage probes, model discovery — went out direct even with a proxy
// configured in the UI. Bun's own HTTPS_PROXY/HTTP_PROXY handling does not cover
// those paths (they carry no per-request `proxy` init).
import { __resetGlobalProxyFetch, installGlobalProxyFetch } from "./bootstrap.ts";

// Untouched platform fetch. The SDK wrapper captures the live global once and
// never unwraps, so a re-install after a settings change must start from here.
let baseFetch: typeof fetch | null = null;

/** (Re)installs the PI_PROXY wrapper. Call after PI_PROXY changes; a no-op when unset. */
export function syncProxyFetch(): void {
  baseFetch ??= globalThis.fetch;
  globalThis.fetch = baseFetch;
  __resetGlobalProxyFetch();
  installGlobalProxyFetch();
}
