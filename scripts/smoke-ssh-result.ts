// Remote-dialog result panel smoke: mount RemoteDialog in a happy-dom window,
// feed a failing ssh_test_result frame, and assert the diagnostic is visible,
// selectable, copyable, and no longer a toast.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-ssh-result.ts (after bun run ui:build).
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;

globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
window.localStorage.setItem("omp-ui-settings", JSON.stringify({ lang: "zh-CN" }));
globalThis.navigator = window.navigator;
// Capture clipboard writes: the WKWebView insecure-context fallback uses a textarea,
// and we assert on the exact payload either way.
const clipboard: string[] = [];
Object.defineProperty(window.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (s: string) => { clipboard.push(s); return Promise.resolve(); } },
});
globalThis.WebSocket = class {};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.location = window.location;
globalThis.URLSearchParams = window.URLSearchParams;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
// Radix dispatches synthetic events built from the ambient globals; Bun's Event
// is a different realm than happy-dom's, so dispatchEvent rejects it. Point the
// realm at the window's own constructors.
for (const name of ["Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent", "FocusEvent", "InputEvent", "WheelEvent", "UIEvent", "NodeFilter", "Node", "Element", "HTMLElement", "DocumentFragment", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
}

document.body.innerHTML = '<div id="root"></div>';

const distDir = join(import.meta.dir, "../ui/dist");
const distHtml = readFileSync(join(distDir, "index.html"), "utf8");
const cssHref = distHtml.match(/<link\b[^>]*rel="stylesheet"[^>]*>/)?.[0]?.match(/href="([^"]+)"/)?.[1];
if (!cssHref) throw new Error("ui/dist/index.html 未找到 stylesheet link");
const styleEl = document.createElement("style");
styleEl.textContent = readFileSync(join(distDir, cssHref), "utf8");
document.head.appendChild(styleEl);

await import("../ui/dist/assets/app.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

const dbg = (window as unknown as { __dbg?: { useAppStore: { getState(): Record<string, unknown>; setState(p: Record<string, unknown>): void } } }).__dbg;
if (!dbg) throw new Error("__dbg 调试钩子未注入");

// The exact `error` field host/rpc/ssh.ts puts on a failed ssh_test_result
// frame: formatSshError(raw stderr) — no translated prefix, octal already decoded.
const FAILURE = [
  "Warning: Identity file C:\\Users\\me\\.ssh\\id_ed25519 not accessible: No such file or directory.",
  "肖鉴松@10.147.17.244: Permission denied (publickey,password,keyboard-interactive).",
].join("\n");
const EXPECTED = `连接失败: ${FAILURE}`;

const asserts: Array<[boolean, string]> = [];
const ok = (name: string, cond: boolean) => asserts.push([cond, name]);

// Open the welcome remote-connection dialog the way a user does: the welcome
// page mounts on isCreatingNew, the project menu owns the "remote" entry, and
// that entry flips the dialog open.
dbg.useAppStore.setState({
  isCreatingNew: true,
  sshHosts: [{ name: "MacMini", host: "10.147.17.244", username: "肖鉴松", port: 22, keyPath: "C:\\Users\\me\\.ssh\\id_ed25519", description: "MacMini" }],
});
await sleep(200);
ok("欢迎页已渲染", !!document.querySelector("#welcomeScreen"));

const projBtn = document.querySelector("#wbProjectBtn");
ok("项目选择胶囊存在", !!projBtn);
(projBtn as unknown as { click(): void })?.click();
await sleep(200);
// The remote entry is an action row (div#wbProjRemote), not a button — and its
// own label is the same Chinese string, so match by id, never by text.
const remoteItem = document.querySelector("#wbProjRemote");
ok("项目菜单含远程连接入口", !!remoteItem);
(remoteItem as unknown as { click(): void })?.click();
await sleep(300);

const dialogTitle = Array.from(document.querySelectorAll("[data-slot='dialog-title'], .confirm-title")).find((el) => (el.textContent ?? "").includes("远程连接"));
ok("远程连接对话框已打开", !!dialogTitle);

const panel = () => document.querySelector(".rd-result");
ok("探测前无结果面板", !panel());

// Land the failing frame the host sends on a failed probe.
dbg.useAppStore.setState({ sshTestResult: { name: null, ok: false, latencyMs: 210, error: FAILURE, ts: Date.now() } });
await sleep(200);

const body = panel()?.querySelector(".rd-result-body") as HTMLElement | null;
ok("结果面板渲染失败诊断", !!body);
ok("面板文本等于「连接失败: 」+ 原始诊断（无重复前缀）", body?.textContent === EXPECTED);
ok("诊断全文可见（CJK 用户名不丢失）", (body?.textContent ?? "").includes("肖鉴松@10.147.17.244: Permission denied"));
ok("不再显示原始八进制转义", !/\\[0-7]{3}/.test(body?.textContent ?? ""));
ok("警告首行完整保留（旧 300 截断会切掉）", (body?.textContent ?? "").includes("not accessible: No such file or directory."));

// The reported symptom: the text must be selectable.
const selectable = (el: Element | null | undefined) => (el ? window.getComputedStyle(el).getPropertyValue("user-select").includes("text") : false);
ok("结果正文可选中（user-select: text）", selectable(body));

// The toast must NOT be used for the failure (it auto-hides and is unselectable).
ok("失败不以 toast 呈现", !document.querySelector("#toast")?.textContent?.includes("Permission denied"));

// Copy button copies the verbatim diagnostic.
const copyBtn = Array.from(panel()?.querySelectorAll("button") ?? []).find((b) => (b.textContent ?? "").includes("复制"));
ok("面板带复制按钮", !!copyBtn);
if (copyBtn) (copyBtn as unknown as { click(): void }).click();
await sleep(150);
ok("复制内容与面板文本逐字一致", clipboard.at(-1) === EXPECTED);
ok("复制成功提示", !!document.querySelector("#toast")?.textContent?.includes("已复制"));

// A successful probe clears the failure panel into a green-stated one.
dbg.useAppStore.setState({ sshTestResult: { name: null, ok: true, latencyMs: 87, ts: Date.now() + 1 } });
await sleep(200);
ok("成功探测渲染成功态", (panel()?.getAttribute("data-ok") ?? "") === "true" && (panel()?.textContent ?? "").includes("87ms"));
ok("成功态同样可选中", selectable(panel()?.querySelector(".rd-result-body") ?? null));

// ---- New flow: form mode is gated on a green probe (test → save → connect) ----
const findBtn = (txt: string) => Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(txt));
const clickBtn = (b: Element | undefined) => (b as unknown as { click(): void } | undefined)?.click();
const isDisabled = (b: Element | undefined) => b?.hasAttribute("disabled") ?? false;
const footerConnect = () => Array.from(document.querySelectorAll(".confirm-actions button")).at(-1);

clickBtn(findBtn("新建主机"));
await sleep(250);
let saveHostBtn = findBtn("保存主机");
ok("表单态保存按钮默认禁用", isDisabled(saveHostBtn));
ok("测试成功前不显示远程工作区区", !document.querySelector(".rd-path-wrap"));
ok("编辑态底部连接按钮禁用", isDisabled(footerConnect()));

// Green probe unlocks save + reveals the workspace section.
dbg.useAppStore.setState({ sshTestResult: { name: null, ok: true, latencyMs: 55, ts: Date.now() + 2 } });
await sleep(200);
ok("测试成功后保存按钮亮起", !isDisabled(saveHostBtn));
ok("测试成功后显示远程工作区区", !!document.querySelector(".rd-path-wrap"));

// Any form edit invalidates the verdict (typing over a green must not save).
const addressInput = Array.from(document.querySelectorAll(".rd-path-wrap ~ *, .confirm-box input")).find(
  (el) => (el as Element).getAttribute?.("placeholder")?.includes("10.0.0.1") ?? false,
) as Element | undefined;
const nativeSet = (input: Element, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};
if (addressInput) nativeSet(addressInput, "10.147.17.245");
await sleep(200);
ok("修改表单后保存按钮重新禁用", isDisabled(saveHostBtn));
ok("修改表单后远程工作区区隐藏", !document.querySelector(".rd-path-wrap"));

// Probe again, then the directory picker: focus + type → debounced ssh_list_dirs → picker renders → click backfills.
dbg.useAppStore.setState({ sshTestResult: { name: null, ok: true, latencyMs: 40, ts: Date.now() + 3 } });
await sleep(150);
const sentFrames: Array<Record<string, unknown>> = [];
dbg.useAppStore.setState({ send: (o: Record<string, unknown>) => sentFrames.push(o) });
const pathInput = document.querySelector(".rd-path-wrap input");
ok("远程路径输入框存在", !!pathInput);
if (pathInput) {
  pathInput.focus();
  pathInput.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  nativeSet(pathInput, "/ho");
  await sleep(400); // debounce 250ms
  const listReq = sentFrames.find((f) => f.type === "ssh_list_dirs");
  ok("输入触发 ssh_list_dirs（base=/）", listReq?.path === "/" && typeof listReq.host === "string");
  dbg.useAppStore.setState({ sshDirs: { ok: true, path: "/", dirs: ["home", "usr", "var", "etc"], ts: Date.now() } });
  await sleep(200);
  const picker = document.querySelector(".rd-path-wrap .menu.rd-dirs");
  const items = Array.from(picker?.querySelectorAll(".mi") ?? []).map((mi) => (mi.textContent ?? "").trim());
  ok("目录弹层按前缀过滤（ho→仅 home）", items.length === 1 && items[0] === "home");
  clickBtn(items.length ? (picker?.querySelector(".mi") as Element) : undefined);
  await sleep(150);
  ok("点击候选回填路径并带尾斜杠", (document.querySelector(".rd-path-wrap input") as unknown as { value: string })?.value === "/home/");
  // Picking appends "/" so the next debounce lists the picked directory (tree walk).
  await sleep(400);
  const nextReq = [...sentFrames].reverse().find((f) => f.type === "ssh_list_dirs");
  ok("回填后继续请求下一层（base=/home/）", nextReq?.path === "/home");
}
ok("编辑态连接按钮始终禁用（先保存）", isDisabled(footerConnect()));

let fail = 0;
for (const [cond, name] of asserts) {
  if (!cond) fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}
console.log(`\n${asserts.length - fail}/${asserts.length} 通过`);
if (fail > 0) console.log(`\n面板 HTML:\n${panel()?.outerHTML ?? "(无面板)"}`);
process.exit(fail > 0 ? 1 : 0);