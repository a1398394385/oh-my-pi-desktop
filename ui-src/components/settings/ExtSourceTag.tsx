// Source badge on asset pages (skills/MCP): inline marker linked with the extension center.
// Data side: store.extensionsByScope (accumulated list_extensions replies per scope); row
// entries match extension entries by kind + path/name, and a hit renders the source badge
// (provider name + level title); when the extension center side is not active (disabled/
// shadowed), a yellow warning badge is appended; a miss renders the fallback (e.g. the
// provider name the skill row carries itself).
import { useEffect, type ReactNode } from "react";
import { useAppStore, send } from "../../store";
import { t } from "../../i18n";
import type { ExtensionItem } from "../../types/frames";

// level → i18n key (unknown levels pass through as-is)
const LEVEL_LABEL_KEYS: Record<string, string> = { user: "settingsPage.shared.levelUser", project: "settingsPage.shared.levelProject", native: "settingsPage.shared.levelNative" };

// Fetch extension data for all scopes when entering an asset page: profile first (its reply carries the scopes list), then each project scope
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

// Re-request every known scope after an on-page toggle: the cached per-scope
// snapshots still carry the pre-toggle state, which kept rendering the stale
// 已禁用/被遮蔽 warning tag next to a switch the user had just flipped.
export function refreshExtSources(): void {
  const byScope = useAppStore.getState().extensionsByScope;
  send({ type: "list_extensions", scope: "profile" });
  for (const sc of byScope.profile?.scopes ?? []) {
    if (sc.id !== "profile") send({ type: "list_extensions", scope: sc.id });
  }
}

// Match an extension entry across scopes: exact path first, then kind+name; when several share a name, active wins
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
  const level = LEVEL_LABEL_KEYS[ext.source.level] ? t(LEVEL_LABEL_KEYS[ext.source.level]) : ext.source.level;
  const stateText =
    ext.state === "active" ? t("settingsPage.shared.stateActive") : ext.state === "shadowed" ? t("settingsPage.shared.stateShadowedBy", { name: ext.shadowedBy ?? t("settingsPage.shared.sameNameEntry") }) : t("settingsPage.ext.extCenterDisabled");
  return (
    <>
      <span className="tag" title={t("settingsPage.ext.sourceTitle", { provider: ext.source.providerName, level, state: stateText })}>
        {ext.source.providerName}
      </span>
      {ext.state !== "active" ? (
        <span className="tag ext-tag-warn">{ext.state === "shadowed" ? t("settingsPage.shared.shadowedTag") : t("settingsPage.shared.disabledTag")}</span>
      ) : null}
    </>
  );
}
