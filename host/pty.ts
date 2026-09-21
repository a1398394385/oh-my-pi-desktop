// 终端 PTY 服务：Bun 宿主内嵌真 pty，对前端暴露 create/write/resize/dispose 四元组
// + 数据帧/退出帧回推（host.ts 的 WS 分发里接线）。
//
// 为什么不直接用 node-pty：它是 NAPI 原生模块，实测 Bun 1.4.2 下 import 成功、
// 但 fork 子进程时 posix_spawnp failed（spawn-helper 起不来）；macOS 自带 script(1)
// 又要求 stdin 必须是 tty。最终方案：host/pty-bridge.c（openpty + fork + exec 的
// ~100 行桥进程，stdio 即 pty 数据管道），宿主首次用时用 cc 编译缓存到
// ~/.omp/profiles/omp-desktop/bin/（Tauri 开发机必有 CLT，按源码 hash 失效重编）。
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const SRC = path.join(import.meta.dir, "pty-bridge.c");

// 编译产物缓存：源码 hash 进文件名，改源码自动重编
function bridgeBin(): string {
  const hash = createHash("sha1").update(readFileSync(SRC)).digest("hex").slice(0, 10);
  const dir = path.join(os.homedir(), ".omp", "profiles", "omp-desktop", "bin");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `pty-bridge-${hash}`);
}

// 确保桥二进制可用：缺失则 cc 编译；cc 不存在时抛错（错误经 WS error 帧回前端）
export async function ensureBridge(): Promise<string> {
  const bin = bridgeBin();
  if (existsSync(bin)) return bin;
  const cc = Bun.spawnSync(["cc", "-O2", "-o", bin, SRC]);
  if (cc.exitCode !== 0) {
    throw new Error(`编译 pty-bridge 失败（需要 Xcode CLT 的 cc）：${cc.stderr.toString().slice(0, 200)}`);
  }
  return bin;
}

// 控制 socket 连接（桥连入后才有 resize 通道；只写不读）
interface CtlSocket { write(data: string): unknown }

export interface PtySession {
  id: string;
  shell: string;
  cwd: string;
  proc: Bun.Subprocess;
  ctl: CtlSocket | null;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
}

const sessions = new Map<string, PtySession>();
const byOwner = new WeakMap<object, Set<string>>();

// 建会话：起桥进程 + 监听控制 socket（桥连入后才有 resize 通道）。
// onData 收到 pty 原始输出（UTF-8 字符串）；onExit 在子进程退出后调用一次。
export async function createTerminal(
  owner: object,
  opts: { id: string; cwd: string; cols: number; rows: number; shell?: string },
  onData: (data: string) => void,
  onExit: (code: number) => void,
): Promise<PtySession> {
  const bin = await ensureBridge();
  const id = opts.id;
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  const sockPath = path.join(os.tmpdir(), `omp-pty-${id}.sock`);
  try { unlinkSync(sockPath); } catch {}

  let ctlResolve: (s: CtlSocket) => void;
  const ctlReady = new Promise<CtlSocket>((r) => (ctlResolve = r));
  const listener = Bun.listen({
    unix: sockPath,
    socket: {
      open(s) { ctlResolve(s); },
      data() { /* ctl 只收不发（resize 由宿主单向下发） */ },
      close() {},
    },
  });

  const proc = Bun.spawn([bin, sockPath, shell, opts.cwd, String(opts.cols), String(opts.rows)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe", // 桥的诊断输出不进数据帧，避免污染终端画面
    env: { ...process.env, TERM: "xterm-256color" },
  });
  const dec = new TextDecoder();
  (async () => {
    for await (const chunk of proc.stdout) onData(dec.decode(chunk, { stream: true }));
  })().catch(() => {});
  // 桥退出（子进程 exit / 父断开）= 会话结束
  proc.exited.then((code) => {
    sessions.delete(id);
    try { listener.stop(); } catch {}
    try { unlinkSync(sockPath); } catch {}
    onExit(code);
  });

  const ctl = await Promise.race([
    ctlReady,
    new Promise<null>((r) => setTimeout(() => r(null), 3000)),
  ]);
  if (!ctl) {
    // 桥没连上 ctl（编译/运行环境异常）：尽快失败，别留个哑会话
    proc.kill("SIGKILL");
    throw new Error("pty-bridge 控制通道建立超时");
  }

  const session: PtySession = {
    id, shell, cwd: opts.cwd, proc, ctl,
    send(data) {
      try { proc.stdin.write(data); } catch {}
    },
    resize(cols, rows) {
      try { ctl?.write(`r ${cols} ${rows}\n`); } catch {}
    },
    dispose() {
      try { proc.kill("SIGKILL"); } catch {}
      sessions.delete(id);
      try { listener.stop(); } catch {}
      try { unlinkSync(sockPath); } catch {}
    },
  };
  sessions.set(id, session);
  let set = byOwner.get(owner);
  if (!set) byOwner.set(owner, (set = new Set()));
  set.add(id);
  return session;
}

// 取会话并校验归属：只许前端操作自己 WS 名下的 PTY（返回 undefined = 不存在或非本人）
export function terminalFor(owner: object, id: unknown): PtySession | undefined {
  if (typeof id !== "string") return undefined;
  const t = sessions.get(id);
  return t && byOwner.get(owner)?.has(id) ? t : undefined;
}

// WS 断开时清掉该前端名下全部会话（前端已不在，PTY 留着就是孤儿进程）
export function disposeTerminalsOf(owner: object) {
  const set = byOwner.get(owner);
  if (!set) return;
  for (const id of [...set]) sessions.get(id)?.dispose();
  byOwner.delete(owner);
}
