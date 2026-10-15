// Host smoke test: a real model drives the full chain (list -> create persisted -> prompt -> load restores history).
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke.ts [host ws url]
// Without an address the script spawns the host child process itself and cleans up the session files it created on exit.
// Assertions cover: turn_end carries cumulative usage; the read tool's details pass displayContent through;
// history restored by load is grouped into loop groups per round (process collapsed, final assistant left outside the group).
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];
const probeFile = `${os.tmpdir()}/omp-desktop-smoke-${Date.now()}.txt`;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
    child!.stdout!.setEncoding("utf8");
    child!.stdout!.on("data", function onLine(chunk) {
      const m = chunk.match(/READY (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        child!.stdout!.off("data", onLine);
        resolve(m[1]);
      }
    });
  }).catch((e) => fail(String(e)));
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl!);
const failTimeout = setTimeout(() => fail("120s 内未完成全部断言"), 120_000);

const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
};

ws.onmessage = async (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case "ready":
      ws.send(JSON.stringify({ type: "list_sessions" }));
      break;
    case "session_list": {
      const total = msg.projects.reduce((n: number, p: any) => p.sessions.length, 0);
      console.log(`列表: ${msg.projects.length} 个 project、${total} 个会话`);
      assert(msg.projects.length > 0, "profile 下应有历史 project");
      for (const p of msg.projects)
        for (const s of p.sessions)
          assert(/\/sessions\/[^/]+\//.test(s.path) && s.path.endsWith(".jsonl"), `会话路径应在 profile sessions 下: ${s.path}`);
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    }
    case "session_created": {
      createdFiles.push(msg.path);
      console.log(`会话建立: ${msg.sessionId.slice(0, 8)} cwd=${msg.cwd}`);
      assert(msg.path.endsWith(".jsonl"), "落盘会话应有 jsonl 路径");
      await writeFile(probeFile, "SMOKE-PROBE-LINE-1\nsecond line\n");
      ws.send(
        JSON.stringify({
          type: "prompt",
          sessionId: msg.sessionId,
          text: `用 read 工具读取 ${probeFile}，然后告诉我第一行的内容，原样引用。`,
        }),
      );
      state.sessionId = msg.sessionId;
      break;
    }
    case "event":
      if (msg.kind === "text_delta") state.deltaText += msg.text;
      else if (msg.kind === "turn_end" && msg.runEnd !== false) {
        // A read-tool prompt ends its tool round first (runEnd:false, no text
        // yet); only the final round carries the reply.
        console.log(`回复: ${state.deltaText.trim().slice(0, 80)}`);
        assert(state.deltaText.includes("SMOKE-PROBE-LINE-1"), "回复应引用探针文件首行");
        assert(msg.usage && msg.usage.input > 0 && msg.usage.output > 0, `turn_end 应带 usage: ${JSON.stringify(msg.usage)}`);
        console.log(`usage: input=${msg.usage.input} output=${msg.usage.output} cacheRead=${msg.usage.cacheRead} cacheWrite=${msg.usage.cacheWrite}`);
        // Drop the old connection's view; reload the same session from disk
        // (load_session would reuse the in-memory pool snapshot, which stays
        // flat — loop grouping only exists in the disk rebuild path)
        ws.send(JSON.stringify({ type: "reload_session", path: createdFiles[0] }));
      }
      break;
    case "messages": {
      // After load the host replies with messages directly (a history snapshot); only handle the one produced by the load
      if (state.loadedId) break;
      state.loadedId = msg.sessionId;
      console.log("恢复历史:", JSON.stringify(msg.messages.map((m: any) => ({ r: m.role, t: (m.text || "").slice(0, 20) }))));
      assert(msg.messages.some((m: any) => m.role === "user" && m.text.includes("read 工具")), "历史应含原 user 消息");
      const loop = msg.messages.find((m: any) => m.role === "loop");
      assert(loop, "历史应把工具轮收进 loop 组");
      assert(loop.collapsed === true, "loop 组默认收起");
      assert(typeof loop.durationSec === "number" && loop.durationSec >= 1, `loop 组应带时长: ${loop.durationSec}`);
      assert(loop.usage && loop.usage.input > 0, `loop 组应带累加 usage: ${JSON.stringify(loop.usage)}`);
      const readTool = (loop.items || []).find((m: any) => m.role === "tool" && m.name === "read");
      assert(readTool, "loop 组内应含 read 工具项");
      assert(readTool.details?.displayContent?.text?.includes("SMOKE-PROBE-LINE-1"), "read 工具应透传 displayContent");
      assert(readTool.details?.resolvedPath === probeFile, `read 应带绝对路径: ${readTool.details?.resolvedPath}`);
      const after = msg.messages[msg.messages.indexOf(loop) + 1];
      assert(after?.role === "assistant" && after.text.includes("SMOKE-PROBE-LINE-1"), "loop 组后应紧跟最终 assistant 回复");
      ws.close();
      break;
    }
    case "error":
      fail(`收到 error: ${msg.message}`);
  }
};

const state = { sessionId: null as string | null, deltaText: "", loadedId: null as string | null };

ws.onopen = () => console.log("WS 已连接");
ws.onerror = (e) => fail(`WS 错误: ${String(e)}`);
ws.onclose = async () => {
  clearTimeout(failTimeout);
  assert(state.loadedId !== null, "未完成 load 恢复断言");
  for (const f of createdFiles) await rm(f).catch(() => {});
  await rm(probeFile).catch(() => {});
  if (child?.pid) child.kill("SIGTERM");
  console.log("冒烟通过 ✓（测试会话文件已清理）");
  process.exit(0);
};
