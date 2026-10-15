import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancelFrustrationRun, getFrustrationEstimate, startFrustrationRun } from "../api";
import { formatCost, formatInteger, formatPercent } from "../data/formatters";
import type { FrustrationEstimate, FrustrationJobStatus, TimeRange } from "../types";
import { Badge, Card, Dot, KeyValues, Modal } from "../ui";

export interface JudgePanelProps {
  active: boolean;
  range: TimeRange;
  judgeAvailable: boolean;
  job: FrustrationJobStatus;
  onRunStarted: () => void;
  onRunChanged: () => void;
}

type EstimateState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; estimate: FrustrationEstimate; range: TimeRange };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function JudgePanel({ active, range, judgeAvailable, job, onRunStarted, onRunChanged }: JudgePanelProps) {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  const [estimate, setEstimate] = useState<EstimateState>({ status: "loading" });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const estimateAbortRef = useRef<AbortController | null>(null);

  const running = job.state === "running";

  const closeModal = useCallback(() => {
    estimateAbortRef.current?.abort();
    estimateAbortRef.current = null;
    setModalOpen(false);
  }, []);

  useEffect(() => {
    if (!active) closeModal();
  }, [active, closeModal]);
  useEffect(() => () => estimateAbortRef.current?.abort(), []);

  const openEstimate = () => {
    estimateAbortRef.current?.abort();
    const controller = new AbortController();
    estimateAbortRef.current = controller;
    const quotedRange = range;
    setEstimate({ status: "loading" });
    setStartError(null);
    setActionError(null);
    setModalOpen(true);
    getFrustrationEstimate(quotedRange, controller.signal).then(
      result => {
        if (!controller.signal.aborted) setEstimate({ status: "ready", estimate: result, range: quotedRange });
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setEstimate({ status: "error", message: errorMessage(err) });
      },
    );
  };

  const proceed = async () => {
    if (estimate.status !== "ready") return;
    setStarting(true);
    setStartError(null);
    try {
      await startFrustrationRun(estimate.range);
      closeModal();
      onRunStarted();
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const cancelRun = async () => {
    setCancelling(true);
    setActionError(null);
    try {
      await cancelFrustrationRun();
      onRunChanged();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  const quote = estimate.status === "ready" ? estimate.estimate : null;
  const primaryAction =
    estimate.status === "loading"
      ? { label: t("settingsPage.stats.frustration.judge.proceed"), onClick: proceed, disabled: true }
      : quote?.available
        ? {
            label: starting ? t("settingsPage.stats.frustration.judge.starting") : t("settingsPage.stats.frustration.judge.proceed"),
            onClick: proceed,
            disabled: starting || quote.messages === 0,
          }
        : undefined;
  const unavailableHint = t("settingsPage.stats.frustration.judge.unavailableHint");

  return (
    <Card
      index={1}
      title={
        <>
          {t("settingsPage.stats.frustration.judge.cardTitle")} <JobBadge job={job} judgeAvailable={judgeAvailable} />
        </>
      }
      description={t("settingsPage.stats.frustration.judge.cardDescription")}
      actions={
        <button
          type="button"
          className="btn"
          data-variant="accent"
          data-size="sm"
          onClick={openEstimate}
          disabled={!judgeAvailable || running}
          title={
            !judgeAvailable
              ? unavailableHint
              : running
                ? t("settingsPage.stats.frustration.judge.buttonRunningTitle")
                : t("settingsPage.stats.frustration.judge.buttonTitle")
          }
        >
          <Sparkles size={13} /> {t("settingsPage.stats.frustration.judge.classifyButton")}
        </button>
      }
    >
      <div className="stack frustration-judge">
        {running ? (
          <JudgeProgress job={job} cancelling={cancelling} onCancel={cancelRun} />
        ) : (
          <JudgeResultLine job={job} />
        )}
        {!judgeAvailable && <p className="micro dim">{unavailableHint}</p>}
        {actionError && (
          <p className="micro tone-bad" role="alert">
            {actionError}
          </p>
        )}
      </div>

      <Modal
        open={modalOpen}
        title={t("settingsPage.stats.frustration.judge.classifyButton")}
        onClose={closeModal}
        primaryAction={primaryAction}
      >
        <EstimateBody estimate={estimate} />
        {startError && (
          <p className="micro tone-bad" role="alert">
            {startError}
          </p>
        )}
      </Modal>
    </Card>
  );
}

function JobBadge({ job, judgeAvailable }: { job: FrustrationJobStatus; judgeAvailable: boolean }) {
  const { t } = useTranslation();
  switch (job.state) {
    case "running":
      return (
        <Badge tone="ok">
          <Dot tone="live" pulse /> {t("settingsPage.stats.frustration.judge.badgeRunning")}
        </Badge>
      );
    case "done":
      return <Badge tone="ok">{t("settingsPage.stats.frustration.judge.badgeDone")}</Badge>;
    case "cancelled":
      return <Badge tone="warn">{t("settingsPage.stats.frustration.judge.badgeCancelled")}</Badge>;
    case "failed":
      return <Badge tone="bad">{t("settingsPage.stats.frustration.judge.badgeFailed")}</Badge>;
    case "idle":
      return (
        <Badge>
          {judgeAvailable
            ? t("settingsPage.stats.frustration.judge.badgeNotRun")
            : t("settingsPage.stats.frustration.judge.badgeRegexOnly")}
        </Badge>
      );
  }
}

function EstimateBody({ estimate }: { estimate: EstimateState }) {
  const { t } = useTranslation();
  if (estimate.status === "loading") return <p className="muted">{t("settingsPage.stats.frustration.judge.estimating")}</p>;
  if (estimate.status === "error") return <p className="tone-bad">{estimate.message}</p>;
  const quote = estimate.estimate;
  if (!quote.available) return <p>{quote.reason}</p>;
  if (quote.messages === 0) {
    return <p>{t("settingsPage.stats.frustration.judge.allJudged")}</p>;
  }
  return (
    <>
      <div className="frustration-quote">
        <span className="dim micro">{t("settingsPage.stats.frustration.judge.estimatedCost")}</span>
        <span className="num frustration-quote-value">≈ {formatCost(quote.cost)}</span>
      </div>
      <KeyValues
        items={[
          {
            key: "messages",
            label: t("settingsPage.stats.frustration.judge.unjudgedMessages"),
            value: formatInteger(quote.messages),
          },
          {
            key: "chars",
            label: t("settingsPage.stats.frustration.judge.proseChars"),
            value: formatInteger(quote.chars),
          },
          {
            key: "tokens",
            label: t("settingsPage.stats.frustration.judge.estimatedTokens"),
            value: formatInteger(quote.inputTokens),
          },
          { key: "judge", label: t("settingsPage.stats.frustration.judge.judgeLabel"), value: quote.judge },
        ]}
      />
      <p className="micro dim">{t("settingsPage.stats.frustration.judge.estimateFootnote")}</p>
    </>
  );
}

function JudgeProgress({
  job,
  cancelling,
  onCancel,
}: {
  job: FrustrationJobStatus;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const finished = job.done + job.failed;
  const share = job.total > 0 ? Math.min(1, finished / job.total) : 0;
  return (
    <div className="stack frustration-progress">
      <div className="row frustration-progress-head">
        <span className="num">
          {t("settingsPage.stats.frustration.judge.progressText", {
            done: formatInteger(job.done),
            total: formatInteger(job.total),
          })}
        </span>
        <span className="num dim">{formatPercent(share)}</span>
        <span className="frustration-spacer" />
        <button
          type="button"
          className="btn"
          data-variant="danger"
          data-size="sm"
          onClick={onCancel}
          disabled={cancelling}
        >
          {cancelling ? t("settingsPage.stats.frustration.judge.cancelling") : t("settingsPage.stats.frustration.judge.cancelRun")}
        </button>
      </div>
      <div
        className="meter frustration-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={job.total}
        aria-valuenow={finished}
      >
        <div className="meter-fill frustration-progress-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <div className="row micro muted frustration-progress-meta">
        <span className={job.failed > 0 ? "tone-bad" : undefined}>
          {t("settingsPage.stats.frustration.judge.failedCount", { count: formatInteger(job.failed) })}
        </span>
        <span>
          {t("settingsPage.stats.frustration.judge.costSoFar")}{" "}
          <span className="num">{formatCost(job.cost)}</span>
        </span>
        {job.judge && <span className="mono">{job.judge}</span>}
        {job.startedAt !== null && (
          <span>
            {t("settingsPage.stats.frustration.judge.elapsed", { time: formatElapsed(Date.now() - job.startedAt) })}
          </span>
        )}
        {job.startedAt !== null && job.done > 0 && (
          <span className="num">
            {t("settingsPage.stats.frustration.judge.perSecond", {
              rate: (job.done / Math.max(1, (Date.now() - job.startedAt) / 1000)).toFixed(0),
            })}
          </span>
        )}
        {job.concurrency > 0 && (
          <span className="num">
            {t("settingsPage.stats.frustration.judge.inFlight", { count: formatInteger(job.concurrency) })}
          </span>
        )}
      </div>
    </div>
  );
}

function JudgeResultLine({ job }: { job: FrustrationJobStatus }) {
  const { t } = useTranslation();
  const progress = t("settingsPage.stats.frustration.judge.progressMessages", {
    done: formatInteger(job.done),
    total: formatInteger(job.total),
  });
  const failed = job.failed > 0 ? t("settingsPage.stats.frustration.judge.failedSuffix", { count: formatInteger(job.failed) }) : "";
  const judge = job.judge ? t("settingsPage.stats.frustration.judge.judgeSuffix", { judge: job.judge }) : "";
  const elapsed =
    job.startedAt !== null && job.finishedAt !== null
      ? t("settingsPage.stats.frustration.judge.elapsedSuffix", {
          time: formatElapsed(job.finishedAt - job.startedAt),
        })
      : "";
  switch (job.state) {
    case "idle":
      return <p className="muted">{t("settingsPage.stats.frustration.judge.resultIdle")}</p>;
    case "running":
      return null;
    case "done":
      return (
        <p className="muted">
          {t("settingsPage.stats.frustration.judge.resultDone", {
            progress,
            failed,
            judge,
            elapsed,
            cost: formatCost(job.cost),
          })}
        </p>
      );
    case "cancelled":
      return (
        <p className="muted">
          {t("settingsPage.stats.frustration.judge.resultCancelled", {
            progress,
            failed,
            cost: formatCost(job.cost),
          })}
        </p>
      );
    case "failed":
      return (
        <p className="muted">
          {t("settingsPage.stats.frustration.judge.resultFailed", {
            progress,
            failed,
            error: job.error ?? t("settingsPage.stats.frustration.judge.unknownError"),
            cost: formatCost(job.cost),
          })}
        </p>
      );
  }
}
