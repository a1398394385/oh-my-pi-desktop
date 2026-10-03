// Capabilities page: runtime status overview of the active session's attached subsystems
// (MCP / LSP / advisor / memory backend / extensions). Data: the get_capabilities snapshot
// refetched on mount, session switch, and the sp-head refresh button; MCP connection updates
// also arrive live via the process-global capabilities_mcp frame (merged in the store).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens } from "../../store";
import { Spin } from "../chat/parts";
import type { CapabilitiesSnapshot } from "../../types/frames";

// Status literal → i18n key + status-dot class. Dot classes: ok green / wait yellow / off faint / bad err.
const STATUS_LABEL: Record<string, string> = {
  connected: "right.capsStConnected",
  connecting: "right.capsStConnecting",
  disconnected: "right.capsStDisconnected",
  ready: "right.capsStReady",
  error: "right.capsStError",
  running: "right.capsStRunning",
  paused: "right.capsStPaused",
  quota_exhausted: "right.capsStQuota",
  no_model: "right.capsStNoModel",
};
const STATUS_DOT: Record<string, string> = {
  connected: "ok",
  ready: "ok",
  running: "ok",
  connecting: "wait",
  paused: "wait",
  no_model: "wait",
  disconnected: "off",
  quota_exhausted: "bad",
  error: "bad",
};

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="cap-sec">
      <div className="cap-sec-head">
        <span>{title}</span>
        {note && <span className="cap-sec-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

// Key-value row: label left, value right; optional status dot before the label and value tone class
function Row({ dot, label, value, tone }: { dot?: string; label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="cap-row">
      <span className="cap-row-l">
        {dot && <i className={"cap-dot " + (STATUS_DOT[dot] ?? "off")} />}
        {label}
      </span>
      <span className={"cap-row-v" + (tone ? " " + tone : "")}>{value}</span>
    </div>
  );
}

export default function CapabilitiesPage() {
  const { t } = useTranslation();
  const session = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const snap = useAppStore((st) => st.capabilities);
  const loading = useAppStore((st) => st.capabilitiesLoading);
  const sessionId = session?.sessionId;
  // A snapshot from another session is stale: show as loading until the refetch lands
  const current: CapabilitiesSnapshot | null = snap && snap.sessionId === sessionId ? snap : null;

  useEffect(() => {
    useAppStore.getState().fetchCapabilities();
  }, [sessionId]);

  if (!session) return <div className="cap-empty">{t("right.noActiveSession")}</div>;
  if (!current) {
    return <div className="cap-empty">{loading ? <Spin /> : t("right.capsEmpty")}</div>;
  }

  return (
    <div className="caps">
      <Section title={t("right.capsMcp")} note={current.mcp.tools > 0 ? t("right.capsToolsCount", { n: current.mcp.tools }) : undefined}>
        {current.mcp.servers.length === 0 ? (
          <div className="cap-none">{t("right.capsNone")}</div>
        ) : (
          current.mcp.servers.map((s) => (
            <Row key={s.name} dot={s.status} label={s.name} value={t(STATUS_LABEL[s.status] ?? "right.capsStDisconnected")} />
          ))
        )}
      </Section>

      <Section title={t("right.capsLsp")}>
        {current.lsp.length === 0 ? (
          <div className="cap-none">{t("right.capsNone")}</div>
        ) : (
          current.lsp.map((s) => (
            <Row
              key={s.name}
              dot={s.status}
              label={s.name}
              value={(s.fileTypes ?? []).join(" · ") || t(STATUS_LABEL[s.status] ?? "right.capsStReady")}
              tone={s.status === "error" ? "bad" : undefined}
            />
          ))
        )}
      </Section>

      <Section title={t("right.capsAdvisor")}>
        {!current.advisor.configured ? (
          <div className="cap-none">{t("right.capsAdvisorOff")}</div>
        ) : (
          <>
            <Row dot={current.advisor.active ? "running" : "paused"} label={t("right.capsActive")} value={current.advisor.active ? t("right.capsYes") : t("right.capsNo")} />
            {current.advisor.model && <Row label={t("right.capsModel")} value={current.advisor.model} />}
            <Row label={t("right.capsCost")} value={`$${current.advisor.cost.toFixed(4)}`} />
            <Row label={t("right.capsTokens")} value={fmtTokens(current.advisor.tokens.total)} />
            <Row label={t("right.capsMessages")} value={String(current.advisor.messages.total)} />
            <Row label={t("right.capsContext")} value={`${fmtTokens(current.advisor.contextTokens)} / ${fmtTokens(current.advisor.contextWindow)}`} />
            {current.advisor.advisors.map((a) => (
              <Row
                key={a.name}
                dot={a.status}
                label={a.name}
                value={`${t(STATUS_LABEL[a.status] ?? "right.capsStPaused")} · $${a.cost.toFixed(4)} · ${fmtTokens(a.tokensTotal)}`}
              />
            ))}
          </>
        )}
      </Section>

      <Section title={t("right.capsMemory")}>
        <Row dot={current.memory.active ? "running" : "off"} label={current.memory.backend} value={current.memory.active ? t("right.capsYes") : t("right.capsNo")} />
        <Row label={t("right.capsWritable")} value={current.memory.writable ? t("right.capsYes") : t("right.capsNo")} />
        <Row label={t("right.capsSearchable")} value={current.memory.searchable ? t("right.capsYes") : t("right.capsNo")} />
        {current.memory.workingCount !== undefined && <Row label={t("right.capsWorking")} value={String(current.memory.workingCount)} />}
        {current.memory.episodicCount !== undefined && <Row label={t("right.capsEpisodic")} value={String(current.memory.episodicCount)} />}
        {current.memory.tripleCount !== undefined && <Row label={t("right.capsTriple")} value={String(current.memory.tripleCount)} />}
        {current.memory.lastMemory && <div className="cap-note" title={current.memory.lastMemory}>{current.memory.lastMemory}</div>}
        {current.memory.error && <div className="cap-note bad">{current.memory.error}</div>}
        {!current.memory.error && current.memory.message && <div className="cap-note">{current.memory.message}</div>}
      </Section>

      <Section title={t("right.capsExtensions")}>
        {!current.extensions.loaded ? (
          <div className="cap-none">{t("right.capsNone")}</div>
        ) : (
          <>
            <Row label={t("right.capsModules")} value={String(current.extensions.paths.length)} />
            <Row label={t("right.capsTools")} value={String(current.extensions.tools.length)} />
            <Row label={t("right.capsCommands")} value={String(current.extensions.commands.length)} />
            {current.extensions.tools.length > 0 && (
              <div className="cap-pills">
                {current.extensions.tools.map((n) => (
                  <span key={n} className="cap-pill">{n}</span>
                ))}
              </div>
            )}
            {current.extensions.commands.length > 0 && (
              <div className="cap-pills">
                {current.extensions.commands.map((n) => (
                  <span key={n} className="cap-pill cmd">/{n}</span>
                ))}
              </div>
            )}
            {current.extensions.diagnostics.map((d, i) => (
              <div key={i} className="cap-note bad" title={d.path}>{d.message}</div>
            ))}
          </>
        )}
      </Section>
    </div>
  );
}
