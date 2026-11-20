// Top band of the context viewer: the estimation note (snapshot time inline),
// the full-width occupancy meter with the compaction threshold, and one row
// carrying the group legend plus the window facts.
import { useMemo } from "react";
import { useAppStore } from "../../store/index";
import { t } from "../../i18n";
import type { ContextViewIndex } from "../../types/frames";
import { allocateUsage, compactTokens, formatCapturedAt, meterSegments } from "./contextViewMath";

export function ContextOverview({ index }: { index: ContextViewIndex }) {
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const allocation = useMemo(() => allocateUsage(index.categories, index.usedTokens), [index]);
  const segments = useMemo(() => meterSegments(index, allocation), [index, allocation]);
  const window = index.contextWindow;
  const percent = window > 0 ? (index.usedTokens / window) * 100 : 0;
  const threshold = index.thresholdTokens;
  const acpTiers = index.acpTiers ?? null;
  // ACP sessions mark the L1/L2/L3 ladder; everyone else keeps the single auto-compact line.
  const tierShare = (tokens: number) => (window > 0 ? Math.min(1, tokens / window) : 0);
  return (
    <section className="cv-overview">
      <p className="cv-note">
        {t("contextViewer.overview.attribution", { time: formatCapturedAt(index.capturedAt, locale) })}
      </p>
      <div className="cv-meter-wrap">
        <div
          className="cv-meter"
          role="meter"
          aria-label={t("contextViewer.a11y.meter")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent * 10) / 10}
          aria-valuetext={`${t("contextViewer.overview.used")} ${index.usedTokens.toLocaleString()} / ${window.toLocaleString()} tokens · ${percent.toFixed(1)}%`}
        >
          {segments.map((segment) => (
            <i
              key={segment.key}
              style={{ width: `${segment.share * 100}%`, backgroundColor: segment.color }}
              data-context-group={segment.key}
              tabIndex={0}
              role="img"
              aria-label={`${t(`contextViewer.${segment.key === "free" ? "categories" : "groups"}.${segment.key}`)} · ${segment.tokens.toLocaleString()} tokens · ${(segment.share * 100).toFixed(1)}%`}
              title={`${t(`contextViewer.${segment.key === "free" ? "categories" : "groups"}.${segment.key}`)} · ${segment.tokens.toLocaleString()} tokens · ${(segment.share * 100).toFixed(1)}%`}
            />
          ))}
        </div>
        {acpTiers
          ? (["l1", "l2", "l3"] as const).map((key, i) =>
              acpTiers[key] > 0 ? (
                <span
                  key={key}
                  className="cv-mark"
                  style={{ left: `${tierShare(acpTiers[key]) * 100}%` }}
                  title={`L${i + 1} · ${compactTokens(acpTiers[key])}`}
                  aria-hidden="true"
                />
              ) : null,
            )
          : threshold !== null && window > 0 ? (
            <span
              className="cv-mark"
              style={{ left: `${tierShare(threshold) * 100}%` }}
              title={`${t("contextViewer.overview.threshold")} ${compactTokens(threshold)}`}
              aria-hidden="true"
            />
          ) : null}
      </div>
      {/* Group legend, window facts and (when present) compaction savings share one row. */}
      <div className="cv-group-legend" aria-label={t("contextViewer.overview.details")}>
        {segments.filter((segment) => segment.key !== "free").map((segment) => (
          <span key={segment.key}>
            <i className="cv-dot" data-context-group={segment.key} style={{ background: segment.color }} aria-hidden="true" />
            <span>{t(`contextViewer.groups.${segment.key}`)}</span>
            <b>{compactTokens(segment.tokens)}</b>
          </span>
        ))}
        <span><span className="cv-fact-k">{t("contextViewer.overview.free")}</span><b>{compactTokens(index.freeTokens)}</b></span>
        {acpTiers ? (
          (["l1", "l2", "l3"] as const).map((key, i) => (
            <span key={key}><span className="cv-fact-k">L{i + 1}</span><b>{compactTokens(acpTiers[key])}</b></span>
          ))
        ) : (
          <span><span className="cv-fact-k">{t("contextViewer.overview.threshold")}</span><b>{threshold === null ? t("contextViewer.overview.noThreshold") : compactTokens(threshold)}</b></span>
        )}
        {index.savedTokens > 0 ? (
          <span><span className="cv-fact-k">{t("contextViewer.overview.saved")}</span><b>{compactTokens(index.savedTokens)}</b></span>
        ) : null}
      </div>
    </section>
  );
}
