// Category legend doubling as the picker: every row carries a label, a count
// and a share, never colour alone (ported from omp-studio's ContextCategoryList).
import { useMemo } from "react";
import { useAppStore } from "../../store/index";
import { t } from "../../i18n";
import type { ContextViewCategoryId, ContextViewIndex } from "../../types/frames";
import { allocateUsage, CATEGORY_GROUP, CATEGORY_TINT, compactTokens, formatShare } from "./contextViewMath";

interface Row {
  key: string;
  label: string;
  tokens: number;
  color: string;
  categoryId: ContextViewCategoryId;
  childKey?: string;
  selectable: boolean;
  child?: boolean;
  note?: string;
}

export function ContextCategoryList({
  index,
  category,
  childKey,
  onSelect,
}: {
  index: ContextViewIndex;
  category: ContextViewCategoryId;
  childKey?: string | undefined;
  onSelect(category: ContextViewCategoryId, childKey?: string): void;
}) {
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const allocation = useMemo(() => allocateUsage(index.categories, index.usedTokens), [index]);
  const rows = useMemo(() => {
    const built: Row[] = [];
    for (const item of index.categories) {
      built.push({
        key: item.id,
        label: t(`contextViewer.categories.${item.id}`),
        tokens: allocation?.get(item.id) ?? item.tokens,
        color: CATEGORY_TINT[item.id],
        categoryId: item.id,
        // Skills has weight but no body; it stays clickable so the list can explain that.
        selectable: item.entries > 0 || item.openable === false,
        ...(item.openable === false ? { note: t("contextViewer.categories.weightOnly") } : {}),
      });
      for (const child of item.children ?? []) {
        // Groups only unfold under their selected parent, so the legend keeps a stable height.
        if (!child.key || item.id !== category) continue;
        built.push({
          key: child.key,
          label: child.label,
          tokens: allocation?.get(child.key) ?? child.tokens,
          color: "var(--faint)",
          categoryId: item.id,
          childKey: child.key,
          selectable: child.entries > 0,
          child: true,
        });
      }
    }
    return built;
    // `lang` is a render dependency only: t() reads the current pack outside React's knowledge.
  }, [index, allocation, category, lang]);

  return (
    <ul className="cv-cats" aria-label={t("contextViewer.a11y.categories")}>
      {rows.map((row) => {
        const active = row.categoryId === category && row.childKey === childKey;
        // Keep the parent outlined while one of its groups is the actual selection.
        const parentActive = !active && !row.childKey && row.categoryId === category && childKey !== undefined;
        return (
          <li key={row.key} data-child={row.child ? "" : undefined}>
            <button
              type="button"
              className="cv-cat"
              data-active={active ? "" : undefined}
              data-parent={parentActive ? "" : undefined}
              aria-pressed={active}
              title={row.note}
              disabled={!row.selectable}
              onClick={() => onSelect(row.categoryId, row.childKey)}
            >
              <i className="cv-dot" data-context-group={CATEGORY_GROUP[row.categoryId]} style={{ background: row.color }} aria-hidden="true" />
              <span className="cv-cat-label">{row.label}</span>
              <b className="cv-cat-tokens">{compactTokens(row.tokens)}</b>
              <span className="cv-cat-share">{formatShare(row.tokens, index.contextWindow)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
