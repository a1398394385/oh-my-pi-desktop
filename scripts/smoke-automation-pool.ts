// Automation-spawned sessions must join the pool before their session_created
// frame reaches the UI; otherwise opening the row fails get_entry_tree with
// session.notFound even though the prompt itself runs.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-automation-pool.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { smokeEnv } from "./smoke-profile.ts";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const title = `automation-pool-${Date.now()}`;
let child: ChildProcess | null = null;
let ws: WebSocket | null = null;
let automationId = "";
let sessionPath = "";
interface HostFrame {
  type: string;
  sessionId?: string;
  path?: string;
  message?: string;
  automations?: Array<{ id: string; title: string }>;
}

const frames: HostFrame[] = [];
const waiters = new Set<(frame: HostFrame) => void>();

function waitFrame(predicate: (frame: HostFrame) => boolean, timeoutMs = 30_000): Promise<HostFrame> {
  const queued = frames.find(predicate);
  if (queued) return Promise.resolve(queued);
  const pending = Promise.withResolvers<HostFrame>();
  const timer = setTimeout(() => {
    waiters.delete(check);
    pending.reject(new Error("timed out waiting for host frame"));
  }, timeoutMs);
  const check = (frame: HostFrame) => {
    if (!predicate(frame)) return;
    clearTimeout(timer);
    waiters.delete(check);
    pending.resolve(frame);
  };
  waiters.add(check);
  return pending.promise;
}

function send(message: Record<string, unknown>): void {
  ws!.send(JSON.stringify(message));
}

try {
  child = spawn("bun", ["host/host.ts"], { cwd: root, env: smokeEnv(), stdio: ["ignore", "pipe", "inherit"] });
  const ready = Promise.withResolvers<string>();
  const timer = setTimeout(() => ready.reject(new Error("host did not become ready")), 30_000);
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    const match = chunk.match(/READY (ws:\/\/\S+)/);
    if (!match) return;
    clearTimeout(timer);
    ready.resolve(match[1]);
  });
  child.once("exit", (code) => ready.reject(new Error(`host exited before READY: ${code}`)));
  const wsUrl = await ready.promise;
  ws = new WebSocket(wsUrl);
  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    frames.push(frame);
    for (const check of [...waiters]) check(frame);
  };
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.reject(new Error("websocket connection failed"));
  await opened.promise;
  await waitFrame((frame) => frame.type === "ready");

  send({
    type: "automations_create",
    automation: {
      title,
      prompt: "/goal",
      cwd: root,
      schedule: { kind: "rule", unit: "daily", interval: 1, hour: 9, minute: 0 },
      recurring: false,
      maxRuns: 1,
    },
  });
  const created = await waitFrame((frame) => frame.type === "automations_list" && Boolean(frame.automations?.some((a) => a.title === title)));
  automationId = created.automations!.find((a) => a.title === title)!.id;
  send({ type: "automations_run_now", id: automationId });
  const started = await waitFrame((frame) => frame.type === "automation_run_started");
  const createdSession = await waitFrame((frame) => frame.type === "session_created" && frame.sessionId === started.sessionId);
  sessionPath = createdSession.path!;

  send({ type: "get_entry_tree", sessionId: started.sessionId });
  const tree = await waitFrame((frame) => frame.sessionId === started.sessionId && (frame.type === "entry_tree" || frame.type === "error"));
  assert.equal(tree.type, "entry_tree", `automation session must accept pool RPCs: ${tree.message ?? "no error"}`);
  console.log("smoke-automation-pool: automation session resolves get_entry_tree");
} finally {
  if (ws?.readyState === 1 && automationId) {
    send({ type: "automations_delete", id: automationId });
    await waitFrame((frame) => frame.type === "automations_list" && !frame.automations?.some((a) => a.id === automationId), 5_000);
  }
  ws?.close();
  child?.kill("SIGTERM");
  if (sessionPath) await rm(sessionPath, { force: true });
}
