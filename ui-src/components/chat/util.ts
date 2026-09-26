// 纯工具函数：原 ui/tool-rows.js 与 ui/sidebar.js 中被 React 组件消费的部分平移
// （原生前端移除后不再从 ui/ 旧模块导入）
import type { ChatItem, ToolItem } from "./chat-types";

// 文件清单去重并归一：斜杠统一、去掉被长路径覆盖的短路径
export function uniqueFiles(files: Iterable<unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const p of files || []) {
    if (typeof p !== "string" || !p) continue;
    const norm = p.replace(/\\/g, "/");
    const i = out.findIndex((x) => x === norm || x.endsWith("/" + norm) || norm.endsWith("/" + x));
    if (i < 0) out.push(norm);
    else if (norm.length > out[i].length) out[i] = norm;
  }
  return out;
}

// ---------- read 工具路径的 `:选择器` 后缀（语法对齐底座 pi-coding-agent 的 read 工具） ----------
// 行号段：L5 / 5 / 5-16 / 5..16 / 5-、5+（开区间，尾数字可省）/ 5+150（自此 150 行）；
// 可逗号串联 5-16,960-973（第三组可选，对齐底座 PMt 正则）
const SEL_NUM = String.raw`L?\d+(?:(?:\.\.|[-+])L?\d*)?`;
// 选择器段：raw / conflicts / img / 行号段 / -N（末尾 N 行）；段间用冒号串联（如 a.rs:2-4:raw）
const SEL_SEG = new RegExp(`^(?:raw|conflicts|img|${SEL_NUM}(?:,${SEL_NUM})*|-\\d+(?:[-+]\\d+)?)$`, "i");
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// 剥离 read 路径尾部的全部 `:选择器` 段，返回纯文件路径（无选择器时原样返回）。
// 图标/文件名/右栏请求都按干净路径走，否则 `style.css:683:raw` 取不到 .css 类型图标。
export function stripReadSelector(p: unknown): string {
  let path = String(p || "");
  const schemeLen = (path.match(URL_SCHEME)?.[0] || "").length; // 跳过 scheme，避免把 http: 当选择器起点
  for (;;) {
    const i = path.lastIndexOf(":");
    if (i <= schemeLen || !SEL_SEG.test(path.slice(i + 1))) return path;
    path = path.slice(0, i);
  }
}

// 选择器里的首个行范围（右栏文件视图高亮用）：`a.css:683:raw` → [683,683]、`a.rs:50+150` → [50,199]；
// 无数字段（raw/conflicts/img/-N）返回 null
export function readSelectorRange(p: unknown): [number, number] | null {
  const s = String(p || "");
  const m = s.slice(stripReadSelector(s).length).replace(/^:/, "").match(/^L?(\d+)(?:(\.\.|[-+])(\d+)?)?/i);
  if (!m) return null;
  const start = Number(m[1]);
  if (!m[2]) return [start, start];
  if (m[2] === "+") return [start, m[3] ? start + Number(m[3]) - 1 : start];
  return [start, m[3] ? Number(m[3]) : start];
}

// 路径拆分为目录与文件名（含尾部分隔符，剥离行号选择器等后缀以保持路径清洁）
export function splitPath(p: unknown): { dir: string; name: string } {
  const norm = stripReadSelector(String(p || "").replace(/\\/g, "/"));
  const i = norm.lastIndexOf("/");
  if (i < 0) return { dir: "", name: norm };
  return { dir: norm.slice(0, i + 1), name: norm.slice(i + 1) };
}

// 工具设备路径（xd://tui 等）：读/写它是调用设备，不是文件读写
const DEVICE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
export function isDevicePath(p: unknown): boolean {
  return typeof p === "string" && DEVICE_SCHEME.test(p);
}

// 设备名（xd://tui → tui）：摘要与同设备分组共用同一口径
export function deviceNameOf(p: unknown): string {
  return typeof p === "string" ? p.replace(DEVICE_SCHEME, "") : "";
}

// 写入工具设备（write/edit 到 xd://…）：不是文件编辑，没有 diff 可看，按设备行渲染
export function isDeviceEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && ["edit", "write", "apply_patch"].includes(item.name || "") && isDevicePath(item.args?.path);
}

// 编辑类工具事件（编辑行 / 更改组按此归类）；设备写入不在此列
export function isEditEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && ["edit", "write", "apply_patch"].includes(item.name || "") && !isDevicePath(item.args?.path);
}

// 读取类工具事件（查阅组按此归类，与更改组同款折叠逻辑）；目录读取不进组（details.isDirectory）
export function isReadEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && (item.name || "") === "read" && item.details?.isDirectory !== true;
}

// 终端类工具事件（终端组按此归类，与更改/查阅组同款折叠逻辑）
export function isCmdEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && ["bash", "shell", "eval"].includes(item.name || "");
}

// 时长格式化：秒 / 分 秒
export function fmtDuration(sec: number): string {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}
