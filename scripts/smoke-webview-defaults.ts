// Real-WebKit verification of the packaged-webview hardening (BUG-118): tauri.conf.json sets
// dragDropEnabled=false so wry hands HTML5 drag/drop BACK to the webview, and release builds have
// no devtools to turn anything off — the only guard is the three window listeners in
// ui-src/shell.ts. The original fix was verified in happy-dom, which is not the engine that ships
// (WKWebView is). This drives the built bundle in Playwright's WebKit and asserts the defaults are
// actually cancelled there.
// Usage: bun run ui:build && bun scripts/smoke-webview-defaults.ts
import { webkit } from "playwright";

const DIST = new URL("../ui/dist/", import.meta.url);

function fail(msg: string): never {
  console.error("✗ " + msg);
  process.exit(1);
}

const entry = Bun.file(new URL("index.html", DIST));
if (!(await entry.exists())) fail("ui/dist 不存在，先跑 bun run ui:build");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const target = new URL("." + rel, DIST);
    const blob = Bun.file(target);
    if (await blob.exists()) return new Response(blob);
    return new Response("not found", { status: 404 });
  },
});

const url = `http://127.0.0.1:${server.port}/?preview=1`;
console.log("静态服务器:", url);

// The local proxy (HTTP_PROXY/HTTPS_PROXY on this machine) must not be inherited by the browser:
// a proxied 127.0.0.1 request answers 502 and the navigation hangs before any assertion runs.
const childEnv = { ...process.env };
delete childEnv.HTTP_PROXY;
delete childEnv.HTTPS_PROXY;
delete childEnv.http_proxy;
delete childEnv.https_proxy;
childEnv.NO_PROXY = "*";
childEnv.no_proxy = "*";

const browser = await webkit.launch({ env: childEnv });
const page = await browser.newPage();
const pageErrors: string[] = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

await page.goto(url, { waitUntil: "load", timeout: 30_000 });
// App mounted = App.tsx's effect ran initShell ('#root' is the React tree, not the shell markers)
await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, undefined, { timeout: 30_000 });

const result = await page.evaluate(() => {
  // Synthetic events with a real trusted shape: a plain Event carrying a dataTransfer-like object
  // is what the guard reads (it only touches dataTransfer.types), and it keeps WebKit from
  // synthesizing a platform drag session.
  const withFiles = (type: string, target: Element) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], files: [] } });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const plain = (type: string, target: Element) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  // A fresh div: keeps another component's own contextmenu / drag handler out of the reading
  const probe = document.createElement("div");
  probe.id = "probe";
  document.body.appendChild(probe);
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  document.body.appendChild(editable);
  const out = {
    dragover: withFiles("dragover", probe),
    drop: withFiles("drop", probe),
    contextmenuBody: plain("contextmenu", probe),
    contextmenuTextarea: plain("contextmenu", ta),
    contextmenuContenteditable: plain("contextmenu", editable),
    // Control: a non-Files drag must keep its native default (in-page drag & drop still works)
    dragoverText: (() => {
      const ev = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: { types: ["text/plain"] } });
      probe.dispatchEvent(ev);
      return ev.defaultPrevented;
    })(),
    webkitEngine: /AppleWebKit/.test(navigator.userAgent),
    leafCleared: false,
  };
  probe.remove();
  ta.remove();
  editable.remove();
  return out;
});

await browser.close();
server.stop(true);

if (pageErrors.length > 0) console.log("页面错误（预览通道常见，不参与断言）:\n  " + pageErrors.slice(0, 5).join("\n  "));

const checks: Array<[string, boolean]> = [
  ["引擎是 WebKit", result.webkitEngine],
  ["dragover(Files) 被取消", result.dragover],
  ["drop(Files) 被取消", result.drop],
  ["contextmenu(body) 被取消", result.contextmenuBody],
  ["contextmenu(textarea) 保留原生", !result.contextmenuTextarea],
  ["contextmenu(contenteditable) 保留原生", !result.contextmenuContenteditable],
  ["dragover(text/plain) 不取消（页内拖放仍可用）", !result.dragoverText],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? "✓ " : "✗ ") + name);
  if (!ok) failed++;
}
if (failed > 0) fail(`${failed} 项断言失败（真实 WebKit）`);
console.log("打包 webview 默认行为冒烟通过 ✓（真实 WebKit，" + checks.length + " 项）");
