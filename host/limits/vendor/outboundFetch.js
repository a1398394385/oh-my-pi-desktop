'use strict';

// Ported from token-monitor src/shared/outboundFetch.js. The original uses
// undici's EnvHttpProxyAgent for proxying; Bun's fetch natively supports the
// { proxy } option, so this port keeps the "proxy env first, lowercase wins
// over uppercase" resolution logic and delegates transport to the global fetch.

function cleanProxyUrl(value) {
  const trimmed = String(value || '').trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}

function proxyEnvValue(env, lowercaseName, uppercaseName) {
  const lower = cleanProxyUrl(env[lowercaseName]);
  if (lower) return lower;
  return cleanProxyUrl(env[uppercaseName]);
}

function resolveProxyUrl(env = process.env) {
  return proxyEnvValue(env, 'https_proxy', 'HTTPS_PROXY')
    || proxyEnvValue(env, 'http_proxy', 'HTTP_PROXY')
    || cleanProxyUrl(env.ALL_PROXY)
    || cleanProxyUrl(env.all_proxy)
    || '';
}

// Returns a fetch implementation: uses Bun's proxy option when a standard
// proxy env is configured, otherwise forwards as-is. An injected deps.fetch
// wins, mirroring upstream (every ported provider threads its probe fetch in
// through deps so deadlines and cancellation keep working).
function createOutboundFetch(env = process.env, deps = {}) {
  if (typeof deps.fetch === 'function') return deps.fetch;
  const proxy = resolveProxyUrl(env);
  return async function outboundFetch(url, init = {}) {
    if (!proxy) return fetch(url, init);
    return fetch(url, { ...init, proxy });
  };
}

module.exports = { createOutboundFetch, resolveProxyUrl };
