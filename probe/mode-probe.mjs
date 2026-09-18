#!/usr/bin/env bun
/**
 * 探针：对比 `omp --mode rpc` 与 `--mode rpc-ui` 在需要审批时的行为差异。
 * 用法：bun mode-probe.mjs <rpc|rpc-ui>
 *
 * 设计：approvalMode 默认是 yolo（不触发审批），所以显式传 --approval-mode=always-ask。
 * 注意：always-ask 是工具级判断——实测 bash echo 不询问、write 才询问，因此 prompt 用 write 触发审批。
 * 脚本自动应答扩展 UI 帧，观察两种模式的差异。
 */
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "rpc";
const cwd = "/tmp/omp-probe";
const TIMEOUT_MS = 90_000;
const PROMPT =
  "必须调用 write 工具在当前目录创建文件 probe.txt（内容为 ok），不要用 bash。完成后只回复 done。";

const child = spawn(
  "omp",
  ["--mode", mode, "--cwd", cwd, "--no-session", "--approval-mode=always-ask"],
  { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env },
);

const kinds = new Map();
const interesting = [];
const stderrChunks = [];
let buf = "";
let settled = false;
let timer;

const bump = (k) => kinds.set(k, (kinds.get(k) ?? 0) + 1);
const send = (obj) => {
  try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch {}
};

function onFrame(f) {
  bump(f.type ?? "unknown");

  if (f.type === "ready") {
    interesting.push({
      type: "ready",
      protocolVersion: f.protocolVersion,
      supported: f.supportedProtocolVersions,
      maxFrameBytes: f.maxFrameBytes,
      maxReassembledFrameBytes: f.maxReassembledFrameBytes,
    });
    send({ id: "s1", type: "get_state" });
  }

  if (f.type === "response" && f.command === "get_state" && f.success) {
    const d = f.data ?? {};
    interesting.push({
      type: "state",
      keys: Object.keys(d).slice(0, 30),
      sample: JSON.stringify(d).slice(0, 500),
    });
    send({ id: "p1", type: "prompt", message: PROMPT });
  }

  if (f.type === "response" && !f.success) {
    interesting.push({
      type: "error-response",
      command: f.command,
      error: String(f.error ?? "").slice(0, 300),
    });
  }

  if (f.type === "extension_ui_request") {
    interesting.push({
      type: "ui_request",
      method: f.method,
      id: f.id,
      title: f.title,
      message: String(f.message ?? "").slice(0, 160),
      timeout: f.timeout,
    });
    if (f.method === "confirm") send({ type: "extension_ui_response", id: f.id, confirmed: true });
    else if (f.method === "select") send({ type: "extension_ui_response", id: f.id, value: (f.options ?? [])[0] ?? "" });
    else if (f.method === "input" || f.method === "editor") send({ type: "extension_ui_response", id: f.id, value: "probe" });
    else if (f.method === "cancel") send({ type: "extension_ui_response", id: f.id, cancelled: true });
  }

  if (f.type === "tool_execution_start") interesting.push({ type: "tool_start", name: f.toolName ?? f.name });
  if (f.type === "tool_execution_end") interesting.push({ type: "tool_end", name: f.toolName ?? f.name, isError: !!f.isError });
  if (f.type === "message_end") {
    const m = f.message ?? {};
    const text = Array.isArray(m.content)
      ? m.content.map((c) => c?.text ?? "").join("")
      : typeof m.text === "string" ? m.text : "";
    if (text.trim()) interesting.push({ type: "text", role: m.role, text: text.replace(/\s+/g, " ").slice(0, 180) });
  }
  if (f.type === "notice") interesting.push({ type: "notice", message: String(f.message ?? "").slice(0, 160) });
  if (f.type === "extension_error" || f.type === "extension_runner_error") {
    interesting.push({ type: "extension_error", detail: JSON.stringify(f).slice(0, 240) });
  }

  if (f.type === "agent_end") report("agent_end");
}

function report(reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { child.kill("SIGKILL"); } catch {}
  const summary = {
    mode,
    reason,
    frameKinds: Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])),
    uiRequests: interesting.filter((i) => i.type === "ui_request"),
    errorResponses: interesting.filter((i) => i.type === "error-response"),
    tools: interesting.filter((i) => i.type === "tool_start" || i.type === "tool_end"),
    texts: interesting.filter((i) => i.type === "text"),
    state: interesting.find((i) => i.type === "state") ?? null,
    notices: interesting.filter((i) => i.type === "notice" || i.type === "extension_error"),
    ready: interesting.find((i) => i.type === "ready") ?? null,
    stderrTail: stderrChunks.join("").slice(-300),
  };
  console.log("=== PROBE_RESULT ===");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { onFrame(JSON.parse(line)); }
    catch { interesting.push({ type: "bad_json", raw: line.slice(0, 140) }); }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => stderrChunks.push(d));

child.on("exit", (code) => {
  if (!settled) report("child_exit_" + code);
});

child.on("error", (err) => {
  stderrChunks.push("spawn_error: " + err.message);
  report("spawn_error");
});

timer = setTimeout(() => report("timeout"), TIMEOUT_MS);
