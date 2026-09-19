// 宿主冒烟：真模型驱动完整链路（list → create 落盘 → prompt → load 恢复历史）。
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke.ts [宿主ws地址]
// 不传地址时本脚本自行拉起宿主子进程，退出时清理测试产生的会话文件。
// 断言覆盖：turn_end 携带累加 usage；read 工具 details 透传 displayContent；
// load 恢复的历史按轮次收进 loop 组（过程收起、最终 assistant 留组外）。
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];
const probeFile = `/tmp/omp-desktop-smoke-${Date.now()}.txt`;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
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
      else if (msg.kind === "turn_end") {
        console.log(`回复: ${state.deltaText.trim().slice(0, 80)}`);
        assert(state.deltaText.includes("SMOKE-PROBE-LINE-1"), "回复应引用探针文件首行");
        assert(msg.usage && msg.usage.input > 0 && msg.usage.output > 0, `turn_end 应带 usage: ${JSON.stringify(msg.usage)}`);
        console.log(`usage: input=${msg.usage.input} output=${msg.usage.output} cacheRead=${msg.usage.cacheRead} cacheWrite=${msg.usage.cacheWrite}`);
        // 关掉旧连接视角，从磁盘 load 恢复同一会话
        ws.send(JSON.stringify({ type: "load_session", path: createdFiles[0] }));
      }
      break;
    case "messages": {
      // load 后宿主直接回 messages（历史快照）；只处理 load 产生的那次
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
