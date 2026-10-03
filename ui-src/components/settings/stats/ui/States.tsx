import { Inbox, RotateCw, TriangleAlert } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function EmptyState({ title, hint }: { title?: ReactNode; hint?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="empty">
      <Inbox size={20} />
      <div className="empty-title">{title ?? t("settingsPage.stats.ui.emptyStateTitle")}</div>
      {hint !== undefined && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="error-state" role="alert">
      <TriangleAlert size={15} />
      <span className="error-state-message">{typeof error === "string" ? error : error.message}</span>
      {onRetry && (
        <button type="button" className="btn icon-btn" data-size="sm" data-variant="ghost" onClick={onRetry}>
          <RotateCw size={13} /> {t("settingsPage.stats.ui.retry")}
        </button>
      )}
    </div>
  );
}

export function Skeleton({
  width = "100%",
  height = 14,
  style,
}: {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}) {
  return <div className="skeleton" style={{ width, height, ...style }} />;
}

export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return <Skeleton height={height} style={{ borderRadius: 8 }} />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 16px 16px" }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={16} width={`${92 - ((i * 13) % 30)}%`} />
      ))}
    </div>
  );
}

export interface QueryViewProps<T> {
  query: { data: T | null; error: Error | null; loading: boolean; refetch: () => void };
  skeleton: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

export function QueryView<T>({ query, skeleton, isEmpty, empty, children }: QueryViewProps<T>) {
  if (query.data === null) {
    if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
    return <>{skeleton}</>;
  }
  return (
    <>
      {query.error && <ErrorState error={query.error} onRetry={query.refetch} />}
      {isEmpty?.(query.data) ? (empty ?? <EmptyState />) : children(query.data)}
    </>
  );
}
