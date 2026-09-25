// 资产页（技能/MCP）来源徽标：与扩展中心联动的行内标识。
// 数据面 store.extensionsByScope（list_extensions 各 scope 回包累积）；行条目按 kind + path/name
// 匹配扩展条目，命中标来源徽标（供应商名 + 级别 title），扩展中心侧非 active（禁用/遮蔽）时
// 追加黄色警示徽标；未命中渲染 fallback（如技能行自带的 provider 名）。
import { useEffect, type ReactNode } from "react";
import { useAppStore, send } from "../../store";
import type { ExtensionItem } from "../../types/frames";

const LEVEL_LABEL: Record<string, string> = { user: "用户", project: "项目", native: "内置" };

// 进入资产页时拉全量 scope 的扩展数据：先 profile（回包带 scopes 清单），再逐项目 scope 补拉
export function useExtSources(): void {
  const scopes = useAppStore((s) => s.extensionsByScope["profile"]?.scopes);
  useEffect(() => {
    send({ type: "list_extensions", scope: "profile" });
  }, []);
  useEffect(() => {
    if (!scopes) return;
    const byScope = useAppStore.getState().extensionsByScope;
    for (const sc of scopes) {
      if (sc.id !== "profile" && !byScope[sc.id]) send({ type: "list_extensions", scope: sc.id });
    }
  }, [scopes]);
}

// 跨 scope 匹配扩展条目：path 精确优先，其次 kind+name；多条同名时 active 优先
function matchExt(items: ExtensionItem[], kind: string, name: string, path?: string): ExtensionItem | undefined {
  const candidates = path
    ? items.filter((x) => x.kind === kind && x.path === path)
    : items.filter((x) => x.kind === kind && x.name === name);
  return candidates.find((x) => x.state === "active") ?? candidates[0];
}

export function ExtSourceTag({ kind, name, path, fallback }: { kind: string; name: string; path?: string; fallback?: ReactNode }) {
  const byScope = useAppStore((s) => s.extensionsByScope);
  const items = Object.values(byScope).flatMap((f) => f.extensions);
  const ext = matchExt(items, kind, name, path);
  if (!ext) return <>{fallback ?? null}</>;
  const level = LEVEL_LABEL[ext.source.level] ?? ext.source.level;
  const stateText =
    ext.state === "active" ? "启用" : ext.state === "shadowed" ? `被 ${ext.shadowedBy ?? "同名条目"} 遮蔽` : "扩展中心已禁用";
  return (
    <>
      <span className="tag" title={`来源：${ext.source.providerName} · ${level} · ${stateText}`}>
        {ext.source.providerName}
      </span>
      {ext.state !== "active" ? (
        <span className="tag ext-tag-warn">{ext.state === "shadowed" ? "遮蔽" : "已禁用"}</span>
      ) : null}
    </>
  );
}
