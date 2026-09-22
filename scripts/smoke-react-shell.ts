// React 壳冒烟：happy-dom 模拟浏览器环境加载 bundle，断言三栏壳/欢迎页/composer 挂载。
// 跑法：bun scripts/smoke-react-shell.ts（先 bun run ui:build）
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;

// happy-dom 没有 createRoot 需要的完整 DOM API 时逐项补齐（React 19 对容器校验宽松）
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
globalThis.navigator = window.navigator;
globalThis.WebSocket = class {}; // preview 模式不连宿主；store 顶层不建 WS（connect 才建）
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
// 旧模块链（markdown.js → core.js → tool-rows/shell 等）顶层构造 ResizeObserver / matchMedia，
// happy-dom 未提供这两个全局——真实 WKWebView 都有，这里补空实现
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.matchMedia = (q: string) => ({
  matches: false,
  media: q,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
globalThis.location = window.location;
globalThis.URLSearchParams = window.URLSearchParams;
globalThis.getComputedStyle = window.getComputedStyle.bind(window); // composer 的 cbar 布局 effect 需要

// 注入静态 DOM（index.html 的 body 结构）
document.body.innerHTML = '<div id="root"></div>';

await import("../ui/assets/app.js");

// React 渲染是异步的（scheduler），等一拍再断言
await new Promise((r) => setTimeout(r, 300));

const $ = (sel) => document.querySelector(sel);
const asserts = [];
const ok = (name, cond) => asserts.push([cond ? "✓" : "✗", name]);

ok("三栏壳挂载（#sidebar/#main/#right）", !!$("#sidebar") && !!$("#main") && !!$("#right"));
ok("preview 模式进会话区（#stream 存在且非欢迎页）", !!$("#stream") && !$("#welcomeScreen"));
ok("消息流渲染（assistant 文本可见）", ($("#stream")?.textContent || "").includes("先读一下样式文件"));
ok("composer 挂载（textarea + 发送钮）", !!($("#composer textarea#input")) && !!$("#sendBtn"));
ok("右栏 tab 渲染（子代理 tab 激活）", ($("#rightTabs")?.textContent || "").includes("子代理"));
ok("无未捕获错误标记", !document.body.getAttribute("data-error"));

let fail = 0;
for (const [mark, name] of asserts) {
  if (mark === "✗") fail++;
  console.log(`${mark} ${name}`);
}
if (fail > 0) {
  console.error(`React 壳冒烟失败：${fail} 项断言未过`);
  process.exit(1);
}
console.log("全部断言通过（React 壳 preview 冒烟）");
