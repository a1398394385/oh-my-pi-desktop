// Renders the base SDK's live JobWidgetView for a background job inside the BgCmdPage
// expand card. The view is data only (title/headline/stage/blocks), so every block is
// drawn with plain DOM + design tokens; no chart dependency.
import { useTranslation } from "react-i18next";
import type {
  JobWidgetBarsBlock,
  JobWidgetBlock,
  JobWidgetGridBlock,
  JobWidgetMeterBlock,
  JobWidgetSparkBlock,
  JobWidgetStatBlock,
  JobWidgetView,
} from "@oh-my-pi/pi-tui/tools/job-widget";

// TspTone -> desktop semantic tokens. warning/pending use --orange (the app's warning ink;
// --yellow fails contrast on light panels); --green-ink is the text-grade green, so one map
// serves both fills and figures.
const TONE_COLOR: Record<string, string> = {
  neutral: "var(--text)",
  accent: "var(--accent)",
  info: "var(--accent)",
  success: "var(--green-ink)",
  warning: "var(--orange)",
  pending: "var(--orange)",
  error: "var(--err)",
  muted: "var(--faint)",
  user: "var(--accent)",
};

function toneColor(tone?: string): string {
  return (tone && TONE_COLOR[tone]) || "var(--text)";
}

/** Value as a percentage of the block's domain, clamped to 0–100. */
function scale(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/** `value / max` clamped to 0–1 (0 for an empty or broken scale), matching the TUI. */
function fraction(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

export default function JobWidget({ view, caption }: { view: JobWidgetView | null; caption?: string | null }) {
  const { t } = useTranslation();
  if (!view) {
    return caption ? (
      <div className="bgw">
        <div className="bgw-caption">{caption}</div>
      </div>
    ) : null;
  }
  return (
    <div className="bgw">
      <div className="bgw-head">
        <b className="bgw-title" title={view.title}>
          {view.title}
        </b>
        {view.state === "authoring" && <span className="bgw-tag">{t("right.bgWidgetAuthoring")}</span>}
        {view.headline && (
          <span className="bgw-glance">
            {view.headline.label && <span className="bgw-muted">{view.headline.label}</span>}
            <b className="bgw-num">{view.headline.text}</b>
            {view.headline.trend && (
              <span style={{ color: toneColor(view.headline.trend.tone) }}>{view.headline.trend.text}</span>
            )}
          </span>
        )}
      </div>
      {caption && <div className="bgw-caption">{caption}</div>}
      {view.stage && (
        <div className="bgw-stage" title={view.stage}>
          {view.stage}
        </div>
      )}
      {view.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
      {view.blocks.length === 0 && !view.stage && <div className="bgw-muted">{t("right.bgWidgetNoData")}</div>}
    </div>
  );
}

function Block({ block }: { block: JobWidgetBlock }) {
  switch (block.kind) {
    case "spark":
      return <Spark block={block} />;
    case "bars":
      return <Bars block={block} />;
    case "meter":
      return <Meter block={block} />;
    case "stat":
      return <Stat block={block} />;
    case "grid":
      return <Grid block={block} />;
    case "text":
      return <div className="bgw-text">{block.text}</div>;
  }
}

function Spark({ block }: { block: JobWidgetSparkBlock }) {
  const { t } = useTranslation();
  if (block.values.length === 0) return <div className="bgw-muted">{t("right.bgWidgetWaiting")}</div>;
  const color = toneColor(block.tone ?? "accent");
  return (
    <div className="bgw-spark-row">
      <div className="bgw-spark" role="img" aria-label={`${block.label} ${block.last}`}>
        <div className="bgw-spark-bars">
          {block.values.map((value, index) => (
            <span
              key={index}
              className="bgw-spark-bar"
              style={{ height: `${Math.max(scale(value, block.min, block.max), 2)}%`, background: color }}
              title={block.tips?.[index]}
            />
          ))}
        </div>
        {block.marks?.map((mark, index) => (
          <span
            key={index}
            className="bgw-spark-mark"
            style={{ bottom: `${scale(mark.value, block.min, block.max)}%`, borderTopColor: toneColor(mark.tone ?? "muted") }}
          />
        ))}
      </div>
      <div className="bgw-spark-side">
        <b className="bgw-num">{block.last}</b>
        <span className="bgw-muted bgw-ellipsis">{block.label}</span>
        {block.marks?.map((mark, index) => (
          <span key={index} className="bgw-mark-lbl" style={{ color: toneColor(mark.tone ?? "muted") }} title={mark.label}>
            ┈ {mark.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Bars({ block }: { block: JobWidgetBarsBlock }) {
  return (
    <div className="bgw-block">
      <div className="bgw-cap">{block.label}</div>
      <div className="bgw-rows">
        {block.items.map((item, index) => (
          <div key={index} className="bgw-row">
            <span className="bgw-row-lbl" title={item.label}>
              {item.label}
            </span>
            <span className="bgw-track">
              <span
                className="bgw-fill"
                style={{ width: `${fraction(item.value, block.max) * 100}%`, background: toneColor(item.tone ?? "accent") }}
              />
            </span>
            <span className="bgw-row-num">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Meter({ block }: { block: JobWidgetMeterBlock }) {
  return (
    <div className="bgw-row">
      <span className="bgw-row-lbl" title={block.label}>
        {block.label}
      </span>
      <span className="bgw-track">
        <span
          className="bgw-fill"
          style={{ width: `${fraction(block.value, 1) * 100}%`, background: toneColor(block.tone ?? "accent") }}
        />
      </span>
      <span className="bgw-row-num">{block.text}</span>
    </div>
  );
}

function Stat({ block }: { block: JobWidgetStatBlock }) {
  return (
    <div className="bgw-stat">
      {block.items.map((item, index) => (
        <span key={index} className="bgw-stat-item">
          <span className="bgw-muted">{item.label}</span>
          <b style={{ color: toneColor(item.tone) }}>{item.text}</b>
          {item.trend && <span style={{ color: toneColor(item.trend.tone) }}>{item.trend.text}</span>}
        </span>
      ))}
    </div>
  );
}

function Grid({ block }: { block: JobWidgetGridBlock }) {
  return (
    <div className="bgw-block">
      {block.label && <div className="bgw-cap">{block.label}</div>}
      <div className="bgw-grid">
        {block.items.map((item, index) => (
          <span key={index} className="bgw-cell" title={item.text}>
            <span className="bgw-cell-lbl">{item.label}</span>
            <span style={{ color: toneColor(item.tone) }}>{item.text}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
