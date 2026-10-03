import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSessionEntryDetail } from "../api";
import { formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceSpan, TraceTrack } from "../types";
import { Badge, Drawer, ErrorState, JsonBlock, KeyValues, Skeleton } from "../ui";

export interface SpanDrawerProps {
  span: TraceSpan | null;
  track: TraceTrack | null;
  onClose: () => void;
  onOpenChildTrack?: (childTrackId: string) => void;
}

interface EntryDetailView {
  message?: {
    role?: string;
    content?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
    model?: string;
    provider?: string;
    stopReason?: string;
    errorMessage?: string;
    duration?: number;
    ttft?: number;
    toolName?: string;
    isError?: boolean;
    details?: unknown;
  };
}

function textBlocks(content: unknown): Array<{ kind: string; text: string }> {
  const blocks: Array<{ kind: string; text: string }> = [];
  if (typeof content === "string") {
    if (content.trim()) blocks.push({ kind: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;
    if ((block.type === "text" || block.type === "thinking") && "text" in block && typeof block.text === "string") {
      blocks.push({ kind: String(block.type), text: block.text });
    }
  }
  return blocks;
}

export function SpanDrawer({ span, track, onClose, onOpenChildTrack }: SpanDrawerProps) {
  const { t } = useTranslation();
  const [entry, setEntry] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number>(0);

  useEffect(() => {
    setEntry(null);
    setError(null);
    setCopied(false);
    setLoading(false);
    if (!span || !track || !span.entryId) return;
    setLoading(true);
    const controller = new AbortController();
    getSessionEntryDetail(track.file, span.entryId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setEntry(data.entry);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [span, track]);

  useEffect(() => () => window.clearTimeout(copyResetRef.current), []);

  if (!span) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry ?? span, null, 2));
      setCopied(true);
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const view: EntryDetailView = entry && typeof entry === "object" ? (entry as EntryDetailView) : {};
  const msg = view.message;
  const usage = msg?.usage;

  const metrics: Array<{ key: string; label: ReactNode; value: ReactNode }> = [
    {
      key: "duration",
      label: t("settingsPage.stats.traceView.drawer.duration"),
      value: (
        <span className="num">
          {formatDurationMs(span.end - span.start)}
          {span.unterminated && (
            <span className="muted"> · {t("settingsPage.stats.traceView.drawer.unterminated")}</span>
          )}
        </span>
      ),
    },
    {
      key: "start",
      label: t("settingsPage.stats.traceView.drawer.start"),
      value: <span className="num">{new Date(span.start).toLocaleTimeString()}</span>,
    },
    {
      key: "track",
      label: t("settingsPage.stats.traceView.drawer.track"),
      value: <span className="mono">{track?.label ?? "-"}</span>,
    },
  ];
  if (span.kind === "model") {
    metrics.push(
      {
        key: "tokens",
        label: t("settingsPage.stats.traceView.drawer.tokens"),
        value: <span className="num">{formatInteger(span.tokens ?? 0)}</span>,
      },
      {
        key: "cost",
        label: t("settingsPage.stats.traceView.drawer.cost"),
        value: <span className="num">${(span.cost ?? 0).toFixed(4)}</span>,
      },
      {
        key: "ttft",
        label: t("settingsPage.stats.traceView.drawer.ttft"),
        value: <span className="num">{formatDurationMs(span.ttft ?? null)}</span>,
      },
      {
        key: "model",
        label: t("settingsPage.stats.traceView.drawer.model"),
        value: <span className="mono">{msg?.model ?? span.model ?? "-"}</span>,
      },
    );
    if (usage) {
      metrics.push({
        key: "split",
        label: t("settingsPage.stats.traceView.drawer.split"),
        value: (
          <span className="num">
            {formatInteger(usage.input ?? 0)} / {formatInteger(usage.output ?? 0)} /{" "}
            {formatInteger(usage.cacheRead ?? 0)}
          </span>
        ),
      });
    }
    if (msg?.provider) {
      metrics.push({
        key: "provider",
        label: t("settingsPage.stats.traceView.drawer.provider"),
        value: <span className="mono">{msg.provider}</span>,
      });
    }
    if (msg?.stopReason) {
      metrics.push({
        key: "stop",
        label: t("settingsPage.stats.traceView.drawer.stopReason"),
        value: <span className="mono">{msg.stopReason}</span>,
      });
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={span.label}
      subtitle={
        <span className="row" style={{ gap: 6 }}>
          <Badge tone={span.isError ? "bad" : "neutral"}>
            {span.isError
              ? t("settingsPage.stats.traceView.drawer.kindErrorBadge", { kind: span.kind })
              : span.kind}
          </Badge>
        </span>
      }
      actions={
        <button
          type="button"
          className="btn icon-btn"
          data-variant="ghost"
          data-icon="true"
          onClick={handleCopy}
          aria-label={t("settingsPage.stats.traceView.drawer.copyRaw")}
          title={t("settingsPage.stats.traceView.drawer.copyRaw")}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      }
    >
      <div className="stack traces-drawer">
        <KeyValues items={metrics} />

        {msg?.errorMessage && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="section-label tone-bad">{t("settingsPage.stats.traceView.drawer.errorMessage")}</div>
            <pre className="code-block traces-pre">{msg.errorMessage}</pre>
          </div>
        )}

        {span.kind === "subagent" && (
          <div className="stack" style={{ gap: 8 }}>
            {span.detail && (
              <>
                <div className="section-label">{t("settingsPage.stats.traceView.drawer.task")}</div>
                <pre className="code-block traces-pre">{span.detail}</pre>
              </>
            )}
            {span.childTrackId && onOpenChildTrack && (
              <div>
                <button
                  type="button"
                  className="btn confirm-btn"
                  data-size="sm"
                  onClick={() => onOpenChildTrack(span.childTrackId ?? "")}
                >
                  {t("settingsPage.stats.traceView.drawer.openChildTrack")}{" "}
                  <span className="mono">{span.childTrackId}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {span.kind === "tool" && span.detail && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="section-label">{t("settingsPage.stats.traceView.drawer.args")}</div>
            <pre className="code-block traces-pre">{span.detail}</pre>
          </div>
        )}

        {loading && (
          <div className="stack">
            <Skeleton height={80} />
            <Skeleton height={160} />
          </div>
        )}
        {error && (
          <ErrorState
            error={t("settingsPage.stats.traceView.drawer.loadError", { message: error.message })}
          />
        )}

        {!loading &&
          entry !== null &&
          textBlocks(msg?.content).map((block, index) => (
            <div key={`${block.kind}-${index}`} className="stack" style={{ gap: 6 }}>
              <div className="section-label">
                {block.kind === "thinking"
                  ? t("settingsPage.stats.traceView.drawer.thinking")
                  : t("settingsPage.stats.traceView.drawer.text")}
              </div>
              <pre className="code-block traces-pre" data-scroll="true">
                {block.text}
              </pre>
            </div>
          ))}

        {!loading && entry !== null && (
          <JsonBlock data={entry} title={t("settingsPage.stats.traceView.drawer.rawEntry")} initialCollapsed={true} />
        )}
      </div>
    </Drawer>
  );
}
