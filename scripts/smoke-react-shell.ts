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

// 斜杠命令补全回归：清单回包后弹层必须立即出候选（旧版 palette 存 items/loading 快照，
// 回包只 notify 不刷新快照 → 候选永不出现，要再敲一键才重算）
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
const slashTa = $("#composer textarea#input") as HTMLTextAreaElement | null;
if (!slashTa) throw new Error("composer textarea 未挂载");
slashTa.value = "/";
slashTa.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(80);
ok("斜杠弹层打开（清单未拉取时加载中）", ($(".menu.palette")?.textContent || "").includes("加载中"));
// __dbg 是 main.jsx preview 模式注入的调试钩子（S/notify），happy-dom Window 类型无声明
const dbg = (window as unknown as { __dbg?: { S: { commands: unknown[]; commandsSessionId: string }; notify(): void } })
  .__dbg;
if (!dbg) throw new Error("__dbg 调试钩子未注入");
dbg.S.commands = [{ name: "compact", aliases: [], description: "压缩上下文", source: "builtin", subcommands: [] }];
dbg.S.commandsSessionId = "preview";
dbg.notify();
await sleep(80);
ok("commands 回包后候选立即出现（无需再次击键）", ($(".menu.palette")?.textContent || "").includes("compact"));

// builtin 命令描述中文化回归：弹层显示 commands-zh.js 译文而非英文原描述
dbg.S.commands = [...dbg.S.commands, { name: "usage", aliases: [], description: "Show token usage", source: "builtin", subcommands: [] }];
dbg.notify();
await sleep(80);
ok("builtin 描述显示中文（commands-zh.js）", ($(".menu.palette")?.textContent || "").includes("查看 token 用量"));

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
// happy-dom Window 与 React scheduler 的定时器占着事件循环，不显式退出会挂到超时
process.exit(0);
