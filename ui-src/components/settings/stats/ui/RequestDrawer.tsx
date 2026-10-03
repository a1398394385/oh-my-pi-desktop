import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { t } from "../../../../i18n";
import { getRequestDetails } from "../api";
import {
  formatCost,
  formatDurationMs,
  formatFolder,
  formatInteger,
  formatMessageCost,
  formatRelativeTime,
  formatTimestamp,
  formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { type RequestStatus, requestStatus } from "../data/view-models";
import type { RequestDetails } from "../types";
import { Badge, type Tone } from "./Badge";
import { Drawer, KeyValues } from "./Drawer";
import { JsonBlock } from "./JsonBlock";
import { ErrorState, Skeleton } from "./States";

// Labels resolve at access time (not module load) so language switches pick up
// the new copy on the next render of any consuming component.
export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  ok: {
    get label() {
      return t("settingsPage.stats.ui.statusOk");
    },
    tone: "ok",
  },
  aborted: {
    get label() {
      return t("settingsPage.stats.ui.statusAborted");
    },
    tone: "warn",
  },
  failed: {
    get label() {
      return t("settingsPage.stats.ui.statusFailed");
    },
    tone: "bad",
  },
};

export interface RequestDrawerProps {
  id: number | null;
  onClose: () => void;
  onOpenSession?: (sessionFile: string) => void;
}

export function RequestDrawer({ id, onClose, onOpenSession }: RequestDrawerProps) {
  const { t } = useTranslation();
  const query = useQuery(["request", id], () => getRequestDetails(id ?? 0), { enabled: id !== null });
  const details = query.stale ? null : query.data;
  const status = details ? REQUEST_STATUS[requestStatus(details)] : null;

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      width={620}
      title={details ? <span className="mono">{details.model}</span> : t("settingsPage.stats.ui.requestTitle")}
      subtitle={
        details ? (
          <>
            {details.provider} ·{" "}
            <span title={formatTimestamp(details.timestamp)}>{formatRelativeTime(details.timestamp)}</span>
          </>
        ) : id !== null ? (
          <span className="mono">#{id}</span>
        ) : undefined
      }
      actions={
        details && status ? (
          <div className="row" style={{ gap: 6 }}>
            {onOpenSession && (
              <button
                type="button"
                className="btn"
                data-size="sm"
                data-variant="ghost"
                onClick={() => {
                  onOpenSession(details.sessionFile);
                  onClose();
                }}
                title={t("settingsPage.stats.ui.traceActionTitle")}
              >
                <GitBranch size={13} /> {t("settingsPage.stats.ui.traceAction")}
              </button>
            )}
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
        ) : undefined
      }
    >
      {details ? (
        <RequestDetailsBody details={details} aborted={requestStatus(details) === "aborted"} />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <Skeleton height={56} />
          <Skeleton height={120} />
          <Skeleton height={120} />
          <Skeleton height={220} />
        </div>
      )}
    </Drawer>
  );
}

function RequestDetailsBody({ details, aborted }: { details: RequestDetails; aborted: boolean }) {
  const { t } = useTranslation();
  const { usage } = details;
  const throughput =
    details.duration !== null && details.duration > 0 && usage.output > 0
      ? (usage.output * 1000) / details.duration
      : null;
  const { messages, output, ...row } = details;

  return (
    <>
      {details.errorMessage && (
        <section className="request-drawer-error" data-tone={aborted ? "warn" : "bad"} role="note">
          <div className="request-drawer-error-label">
            {aborted ? t("settingsPage.stats.ui.statusAborted") : t("settingsPage.stats.ui.errorLabel")}
          </div>
          <pre className="request-drawer-error-text">{details.errorMessage}</pre>
        </section>
      )}

      <section>
        <div className="section-label">{t("settingsPage.stats.ui.sectionTiming")}</div>
        <KeyValues
          items={[
            { key: "at", label: t("settingsPage.stats.ui.fieldStarted"), value: formatTimestamp(details.timestamp) },
            { key: "duration", label: t("settingsPage.stats.ui.fieldDuration"), value: formatDurationMs(details.duration) },
            { key: "ttft", label: t("settingsPage.stats.ui.fieldTtft"), value: formatDurationMs(details.ttft) },
            { key: "tps", label: t("settingsPage.stats.ui.fieldTps"), value: formatTokensPerSecond(throughput) },
          ]}
        />
      </section>

      <section>
        <div className="section-label">{t("settingsPage.stats.ui.sectionTokens")}</div>
        <KeyValues
          items={[
            { key: "input", label: t("settingsPage.stats.ui.fieldUncachedInput"), value: formatInteger(usage.input) },
            { key: "cacheRead", label: t("settingsPage.stats.ui.fieldCacheRead"), value: formatInteger(usage.cacheRead) },
            { key: "cacheWrite", label: t("settingsPage.stats.ui.fieldCacheWrite"), value: formatInteger(usage.cacheWrite) },
            { key: "output", label: t("settingsPage.stats.ui.fieldOutput"), value: formatInteger(usage.output) },
            { key: "total", label: t("settingsPage.stats.ui.fieldTotal"), value: formatInteger(usage.totalTokens) },
            {
              key: "premium",
              label: t("settingsPage.stats.ui.fieldPremiumRequests"),
              value: formatInteger(Math.round((usage.premiumRequests ?? 0) * 100) / 100),
            },
          ]}
        />
      </section>

      <section>
        <div className="section-label">{t("settingsPage.stats.ui.sectionCost")}</div>
        <KeyValues
          items={[
            { key: "total", label: t("settingsPage.stats.ui.fieldTotal"), value: formatMessageCost(details, 4) },
            { key: "input", label: t("settingsPage.stats.ui.fieldInput"), value: formatCost(usage.cost.input, 4) },
            { key: "cacheRead", label: t("settingsPage.stats.ui.fieldCacheRead"), value: formatCost(usage.cost.cacheRead, 4) },
            { key: "cacheWrite", label: t("settingsPage.stats.ui.fieldCacheWrite"), value: formatCost(usage.cost.cacheWrite, 4) },
            { key: "output", label: t("settingsPage.stats.ui.fieldOutput"), value: formatCost(usage.cost.output, 4) },
          ]}
        />
      </section>

      <section>
        <div className="section-label">{t("settingsPage.stats.ui.sectionIdentity")}</div>
        <KeyValues
          items={[
            { key: "id", label: t("settingsPage.stats.ui.fieldRequestId"), value: details.id ?? "–" },
            { key: "entry", label: t("settingsPage.stats.ui.fieldEntryId"), value: details.entryId },
            { key: "stop", label: t("settingsPage.stats.ui.fieldStopReason"), value: details.stopReason },
            { key: "api", label: t("settingsPage.stats.ui.fieldApi"), value: details.api },
            {
              key: "project",
              label: t("settingsPage.stats.ui.fieldProject"),
              value: <span title={details.folder}>{formatFolder(details.folder)}</span>,
            },
          ]}
        />
        <div className="request-drawer-file">
          <span className="kv-key">{t("settingsPage.stats.ui.fieldSessionFile")}</span>
          <span className="kv-value">{details.sessionFile}</span>
        </div>
      </section>

      <JsonBlock data={output} title={t("settingsPage.stats.ui.titleOutputMessage")} />
      <JsonBlock data={messages} title={t("settingsPage.stats.ui.titleSessionEntry")} initialCollapsed />
      <JsonBlock data={row} title={t("settingsPage.stats.ui.titleStatsRow")} initialCollapsed />
    </>
  );
}
