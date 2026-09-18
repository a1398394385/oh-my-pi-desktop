// 宿主冒烟：真模型驱动完整链路（list → create 落盘 → prompt → load 恢复历史）。
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke.ts [宿主ws地址]
// 不传地址时本脚本自行拉起宿主子进程，退出时清理测试产生的会话文件。
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const args = process.argv.slice(2);

let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];

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
    child!.stdout!.on("data", function onLine(chunk: string) {
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
const failTimeout = setTimeout(() => fail("90s 内未完成全部断言"), 90_000);

const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  switch (msg.type) {
    case "ready":
      ws.send(JSON.stringify({ type: "list_sessions" }));
      break;
    case "session_list": {
      const total = msg.projects.reduce((n: number, p: any) => n + p.sessions.length, 0);
      console.log(`列表: ${msg.projects.length} 个 project、${total} 个会话`);
      assert(msg.projects.length > 0, "profile 下应有历史 project");
      for (const p of msg.projects)
        for (const s of p.sessions)
          assert(s.path.includes("omp-desktop"), `会话路径应在 profile 下: ${s.path}`);
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    }
    case "session_created": {
      createdFiles.push(msg.path);
      console.log(`会话建立: ${msg.sessionId.slice(0, 8)} cwd=${msg.cwd}`);
      assert(msg.path.endsWith(".jsonl"), "落盘会话应有 jsonl 路径");
      ws.send(JSON.stringify({ type: "prompt", sessionId: msg.sessionId, text: "1+1 等于几？只回答阿拉伯数字。" }));
      state.sessionId = msg.sessionId;
      break;
    }
    case "event":
      if (msg.kind === "text_delta") state.deltaText += msg.text;
      else if (msg.kind === "turn_end") {
        console.log(`回复: ${state.deltaText.trim()}`);
        assert(state.deltaText.includes("2"), "回复应包含 2");
        // 关掉旧连接视角，从磁盘 load 恢复同一会话
        ws.send(JSON.stringify({ type: "load_session", path: createdFiles[0] }));
      }
      break;
    case "messages": {
      // load 后宿主直接回 messages（历史快照）；只处理 load 产生的那次
      if (state.loadedId) break;
      state.loadedId = msg.sessionId;
      const roles = msg.messages.map((m: any) => m.role).join(",");
      console.log("恢复历史:", JSON.stringify(msg.messages.map((m: any) => ({ r: m.role, t: m.text.slice(0, 20) }))));
      assert(msg.messages.some((m: any) => m.role === "user" && m.text.includes("1+1")), "历史应含原 user 消息");
      assert(msg.messages.some((m: any) => m.role === "assistant" && m.text.includes("2")), "历史应含落盘的回复");
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
  if (child?.pid) child.kill("SIGTERM");
  console.log("冒烟通过 ✓（测试会话文件已清理）");
  process.exit(0);
};
