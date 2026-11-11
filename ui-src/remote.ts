// Remote-mode predicate (remote-control spec §4.1): outside the Tauri shell and
// not the ?preview=1 debug page = a browser remote client; a ?ws= dev direct-connect
// is a local channel instead. Lives in its own module (no store imports) so
// non-store consumers (e.g. components/WindowControls.tsx) can use it without an
// import cycle through store/index.ts.
export const REMOTE =
  !window.__TAURI__?.core?.invoke &&
  !new URLSearchParams(location.search).has("preview") &&
  !new URLSearchParams(location.search).has("ws");
