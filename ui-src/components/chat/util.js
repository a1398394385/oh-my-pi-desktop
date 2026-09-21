// 纯工具函数：原 ui/tool-rows.js 与 ui/sidebar.js 中被 React 组件消费的部分平移
// （原生前端移除后不再从 ui/ 旧模块导入）

// 文件清单去重并归一：斜杠统一、去掉被长路径覆盖的短路径
export function uniqueFiles(files) {
  const out = [];
  for (const p of files || []) {
    if (typeof p !== "string" || !p) continue;
    const norm = p.replace(/\\/g, "/");
    const i = out.findIndex((x) => x === norm || x.endsWith("/" + norm) || norm.endsWith("/" + x));
    if (i < 0) out.push(norm);
    else if (norm.length > out[i].length) out[i] = norm;
  }
  return out;
}

// 路径拆分为目录与文件名（含尾部分隔符）
export function splitPath(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { dir: "", name: norm };
  return { dir: norm.slice(0, i + 1), name: norm.slice(i + 1) };
}

// 编辑类工具事件（编辑行 / 更改组按此归类）
export function isEditEvent(item) {
  return item.role === "tool" && ["edit", "write", "apply_patch"].includes(item.name || "");
}

// 时长格式化：秒 / 分 秒
export function fmtDuration(sec) {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}
