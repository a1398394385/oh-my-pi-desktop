'use strict';

// 移植自 token-monitor src/shared/outboundFetch.js。原版用 undici 的
// EnvHttpProxyAgent 实现代理;Bun 的 fetch 原生支持 { proxy } 选项,
// 这里保留「代理 env 优先、小写胜过大写」的解析逻辑,传输层交给全局 fetch。

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

// 返回一个 fetch 实现:配置了标准代理 env 时走 Bun 的 proxy 选项,否则原样转发。
function createOutboundFetch(env = process.env) {
  const proxy = resolveProxyUrl(env);
  return async function outboundFetch(url, init = {}) {
    if (!proxy) return fetch(url, init);
    return fetch(url, { ...init, proxy });
  };
}

module.exports = { createOutboundFetch, resolveProxyUrl };
