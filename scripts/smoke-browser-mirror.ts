// Smoke: the Agent browser live mirror end-to-end, against a REAL headless
// Chromium. Exercises exactly the production path: the SDK tab registry
// (acquireBrowser/acquireTab, same module instance the browser tool uses in
// the host) -> host/browser-mirror.ts poll + browser_tabs pushes + CDP
// Page.startScreencast stills over a fake UI ws. The UI store itself is
// covered by typecheck/build; this proves the risky host-side half.
//
// OMP_PROFILE pins the test profile; the throwaway agent dir keeps the shared
// browser daemon scoped to the smoke. Dynamic imports are deliberate (env
// first, module graphs after — same shape as smoke-external-browser.ts).
process.env.OMP_PROFILE = process.env.OMP_PROFILE ?? "omp-desktop-test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PuppeteerBrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";

const agentDir = mkdtempSync(join(tmpdir(), "omp-browsermirror-"));
writeFileSync(join(agentDir, "omp-desktop.json"), JSON.stringify({ ui: { locale: "en" } }, null, 2));
process.env.OMP_AGENT_DIR = agentDir;

interface Case { name: string; ok: boolean; detail: string }
const results: Case[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  results.push({ name, ok, detail });
};
const fail = (msg: string): never => {
  console.error("SMOKE ABORT: " + msg);
  process.exit(1);
};

// Fake UI websocket capturing every pushed frame.
interface SentFrame {
  type: string;
  tabs?: { name: string; mirrorable: boolean; url?: string }[];
  active?: boolean;
  name?: string;
  data?: string;
  w?: number;
  h?: number;
  s?: number;
}
const sent: SentFrame[] = [];
const fakeWs = {
  send(raw: string) {
    const frame = JSON.parse(raw) as SentFrame;
    sent.push(frame);
  },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Wait until a frame matching pred has arrived (the poll runs at 500ms).
async function waitForFrame(pred: (f: SentFrame) => boolean, ms: number): Promise<SentFrame | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = sent.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  const mirror = await import("../host/browser-mirror.ts");
  const { H } = await import("../host/state.ts");
  const { Settings } = await import("../host/bootstrap.ts");
  H.agentDir = agentDir;
  H.settings = await Settings.init({ cwd: agentDir, agentDir });

  const { acquireBrowser, releaseBrowser } = await import(
    "@oh-my-pi/pi-coding-agent/tools/browser/registry"
  );
  const { acquireTab, releaseAllTabs, listTabs } = await import(
    "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor"
  );

  mirror.startBrowserMirror(); // production: main.ts starts the poll at boot
  mirror.browserMirrorSubscribe(fakeWs, { width: 600 });
  const emptySnapshot = await waitForFrame((f) => f.type === "browser_tabs", 3000);
  check("subscribe replies with a browser_tabs snapshot", !!emptySnapshot);
  check("empty snapshot carries no tabs", emptySnapshot?.tabs?.length === 0, JSON.stringify(emptySnapshot?.tabs));

  // 2. Open a real tab on the built-in (headless) Chromium — the exact
  // acquire path invokeBrowser takes in the host process.
  const kind: PuppeteerBrowserKind = { kind: "headless", headless: true };
  const browser = await acquireBrowser(kind, { cwd: agentDir });
  await acquireTab("main", browser, { timeoutMs: 60_000, url: "about:blank" });
  check("tab registered in the supervisor registry", listTabs().some((t) => t.name === "main"));

  // 3. The poll must push the activation edge (auto-open signal).
  const edge = await waitForFrame((f) => f.type === "browser_tabs" && (f.tabs?.length ?? 0) > 0, 4000);
  check("activation edge pushed as browser_tabs", !!edge);
  check("edge flagged active (auto-open signal)", edge?.active === true, String(edge?.active));
  check(
    "tab marked mirrorable",
    edge?.tabs?.some((t) => t.name === "main" && t.mirrorable) === true,
  );

  // 4. Screencast stills must flow (reconcile attaches on the next poll tick).
  const still = await waitForFrame((f) => f.type === "browser_frame" && typeof f.data === "string" && f.data.length > 100, 15_000);
  check("screencast stills arrive as browser_frame", !!still, still ? `jpeg ${still.data?.length}B` : "no frame");
  check("still carries page geometry", !!still && typeof still.w === "number" && typeof still.h === "number", `${still?.w ?? "?"}x${still?.h ?? "?"}`);

  // 4b. Interactive mirror: a browser_input click at the page center must
  // reach the real page (a full-size button flips document.title).
  const live0 = "browser" in browser ? browser.browser : undefined;
  // Match the mirrored TARGET exactly: the shared daemon may host leftover
  // about:blank pages from earlier runs, and URL matching grabs the wrong one.
  const targetId = listTabs().find((t) => t.name === "main")?.targetId;
  const page0 = live0 && targetId
    ? (await live0.pages()).find((p) => (p.target() as unknown as { _targetId?: string })._targetId === targetId)
    : undefined;
  if (page0 && still?.w && still?.h) {
    await page0
      .setContent('<button id="b" style="position:fixed;inset:0;width:100vw;height:100vh" onclick="document.title=\'CLICKED\'">go</button>')
      .catch(() => undefined);
    // The compositor needs a submitted frame before synthesized input can
    // hit-test; a real user always sees a frame first, so wait for one here.
    await sleep(600);
    await page0
      .evaluate(() => {
        (window as unknown as { __ev: string[] }).__ev = [];
        document.addEventListener("mousedown", () => (window as unknown as { __ev: string[] }).__ev.push("md"));
        document.addEventListener("click", () => (window as unknown as { __ev: string[] }).__ev.push("click"));
        const b = document.getElementById("b");
        if (b) b.addEventListener("click", () => (window as unknown as { __ev: string[] }).__ev.push("btn"));
        return (document.getElementById("b") ? "dom-ok" : "dom-missing") as string;
      })
      .then((dom) => { if (dom !== "dom-ok") console.log("[smoke] dom probe:", dom); });
    mirror.browserMirrorInput({ name: "main", op: "mouse", action: "down", x: Math.round(still.w / 2), y: Math.round(still.h / 2), button: "left", count: 1 });
    mirror.browserMirrorInput({ name: "main", op: "mouse", action: "up", x: Math.round(still.w / 2), y: Math.round(still.h / 2), button: "left", count: 1 });
    const events = await Promise.race([
      page0.evaluate(() => (window as unknown as { __ev: string[] }).__ev.join(",")),
      sleep(1500).then(() => "(timeout)"),
    ]);
    const title = await page0.title().catch(() => "");
    // title flip == the synthesized click reached the page's DOM event chain
    // (inline onclick cannot fire any other way); events is diagnostic only.
    check("interactive click reaches the page", title === "CLICKED", `title=${JSON.stringify(title)} events=${JSON.stringify(events)}`);

  } else {
    check("interactive click reaches the page", false, "page or geometry missing");
  }

  // 5. Unsubscribe must stop the stream (no further stills after a grace period).
  const countAtUnsub = sent.filter((f) => f.type === "browser_frame").length;
  mirror.browserMirrorUnsubscribe();
  await sleep(1500);
  // Drive a repaint to prove nothing is mirrored anymore.
  const live = "browser" in browser ? browser.browser : undefined;
  const page = live ? (await live.pages()).find((p) => p.url().startsWith("about:")) : undefined;
  if (page) await page.setContent("<h1>post-unsubscribe repaint</h1>").catch(() => undefined);
  await sleep(800);
  const countAfter = sent.filter((f) => f.type === "browser_frame").length;
  check("unsubscribe stops stills", countAfter <= countAtUnsub + 1, `${countAtUnsub} -> ${countAfter}`);

  await releaseAllTabs({});
  await releaseBrowser(browser, { kill: false }).catch(() => undefined);
} catch (err) {
  fail(String(err instanceof Error ? err.stack ?? err.message : err));
} finally {
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // Windows lock window; the temp dir is disposable
  }
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
console.log(failed.length === 0 ? "SMOKE OK: browser mirror end-to-end" : `SMOKE FAIL: ${failed.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
