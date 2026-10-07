// set_model_role role-reference smoke: writing "@smol" (RolePicker reference
// section) must persist and round-trip through the model_roles frame; an
// unknown "@nope" reference and a bogus "provider/model" must still error.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-model-role-ref.ts
import { spawn, type ChildProcess } from "node:child_process";

let child: ChildProcess | null = null;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env },
  stdio: ["ignore", "pipe", "inherit"],
});
const wsUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      resolve(m[1]);
    }
  });
}).catch((e) => fail(String(e)));

const ws = new WebSocket(wsUrl);
const failTimeout = setTimeout(() => fail("60s 内未完成断言"), 60_000);

// The host pushes model_roles only after a successful write (and on
// get_model_roles), so each frame maps 1:1 onto a step: write → echo →
// negative ref → negative model → clear → echo → done.
type Step = "ref" | "badRef" | "badModel" | "restore" | "done";
let step: Step = "ref";

function isRoleEntry(e: unknown): e is { id: unknown; value: unknown; resolved: unknown } {
  return !!e && typeof e === "object" && "id" in e && "value" in e && "resolved" in e;
}

function handleFrame(frame: unknown): void {
  if (!frame || typeof frame !== "object" || !("type" in frame)) return;
  const type = frame.type;
  if (typeof type !== "string") return;

  if (type === "ready") {
    ws.send(JSON.stringify({ type: "set_model_role", role: "slow", value: "@smol" }));
    return;
  }

  if (type === "model_roles" && (step === "ref" || step === "restore")) {
    const roles = "roles" in frame && Array.isArray(frame.roles) ? frame.roles : [];
    const slow = roles.filter(isRoleEntry).find((r) => r.id === "slow");
    const expected = step === "ref" ? "@smol" : null;
    if ((slow?.value ?? null) !== expected) fail(`slow 角色值应为 ${expected}, got ${String(slow?.value)}`);
    if (step === "ref") {
      console.log(`slow = @smol ✓ (resolved: ${String(slow?.resolved ?? "null")})`);
      step = "badRef";
      ws.send(JSON.stringify({ type: "set_model_role", role: "slow", value: "@nope" }));
    } else {
      console.log("slow 已恢复默认 ✓");
      step = "done";
      ws.close();
    }
    return;
  }

  if (type === "error" && "message" in frame) {
    const message = String(frame.message);
    if (step === "badRef") {
      if (!message.includes("未知角色引用") && !message.includes("Unknown role reference"))
        fail(`@nope 应报未知角色引用, got: ${message}`);
      console.log(`@nope → "${message}" ✓`);
      step = "badModel";
      ws.send(JSON.stringify({ type: "set_model_role", role: "slow", value: "nope/nope" }));
    } else if (step === "badModel") {
      if (!message.includes("未知模型") && !message.includes("Unknown model"))
        fail(`nope/nope 应报未知模型, got: ${message}`);
      console.log(`nope/nope → "${message}" ✓`);
      step = "restore";
      ws.send(JSON.stringify({ type: "set_model_role", role: "slow", value: null }));
    } else {
      fail(`意外 error: ${message}`);
    }
  }
}

ws.onmessage = (ev) => handleFrame(JSON.parse(String(ev.data)));
ws.onopen = () => console.log("WS 已连接");
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onclose = () => {
  clearTimeout(failTimeout);
  if (step !== "done") fail(`流程未完成 (step=${step})`);
  console.log("set_model_role 角色引用冒烟通过 ✓");
  if (child?.pid) child.kill("SIGTERM");
  process.exit(0);
};
