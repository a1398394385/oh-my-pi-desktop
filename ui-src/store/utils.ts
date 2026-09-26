// 跨域纯格式化工具(无状态,自 store.ts 平移;P3 波 2)
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

// 路径末段（项目 / 目录 / 文件显示名）：同时认 POSIX 与 Windows 分隔符，并剥掉尾部分隔符。
// 例："C:\Users\x\proj\" → "proj"、"/a/b" → "b"；整串都是分隔符（根）时原样返回。
// 旧写法 split("/") 在 Windows 上整串不分割，项目名会显示成全路径。
export function pathBase(p: string | null | undefined): string {
  const raw = String(p ?? "");
  const s = raw.replace(/[/\\]+$/, "");
  if (!s) return raw;
  return s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1);
}

// 时长格式化（毫秒）：秒 / 分秒 / 小时分钟（原 settings/StatsPage 的 fmtDurationMs 平移，跨页共用）
export function fmtDurationMs(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "秒";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "分" + (s % 60) + "秒";
  const h = Math.floor(m / 60);
  return h + "小时" + (m % 60) + "分钟";
}
