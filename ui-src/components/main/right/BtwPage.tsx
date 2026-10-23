// /btw Side Chat, modeled on the dsh subagent chat's operation logic: a topic directory,
// then one conversation view per topic that holds every follow-up. The host serializes
// turns inside a topic, so a running topic disables the composer and offers Stop — new
// topics stay available from the directory.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import { DOUBLE_ESC_MS } from "../../../keys";
import { pushInputHistory, recallHistory, resetHistoryCursor } from "../../composer/lexical/draft";
import Icon from "../../../Icon";
import MdSurface from "../../chat/MdSurface";
import type { BtwRecord, BtwTurn } from "../../../types/frames";

/** Opening turn first, then follow-ups: the transcript order of one topic. */
function turnsOf(topic: BtwRecord): readonly BtwTurn[] {
  return topic.followUps?.length ? [topic, ...topic.followUps] : [topic];
}

function topicTitle(topic: BtwRecord): string {
  const firstLine = topic.question.split("\n")[0] ?? "";
  return firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
}

/** One shared draft: switching topics or sessions starts from a clean composer. */
function Composer({
  placeholder,
  busy,
  autoFocus,
  onSubmit,
  onStop,
}: {
  placeholder: string;
  busy: boolean;
  autoFocus?: boolean;
  onSubmit(text: string): void;
  onStop?(): void;
}) {
  const { t } = useTranslation();
  const draft = useAppStore((s) => s.btwDraft);
  const setDraft = useAppStore((s) => s.btwSetDraft);
  const sessionId = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath)?.sessionId : undefined));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Every side topic of one session shares one history slot; the "btw:" prefix keeps it
  // apart from the main composer's slot (keyed by session path).
  const historyKey = `btw:${sessionId ?? "none"}`;
  // Browsing re-arms only from an empty input, so the slot's live-draft snapshot that
  // recallHistory() takes is always blank -- the btw draft lives in the store, not in
  // composer/lexical/draft.ts.
  const browsingRef = useRef(false);
  const escAtRef = useRef(0);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  const submit = () => {
    if (busy || !draft.trim()) return;
    pushInputHistory(historyKey, { text: draft, files: [] });
    browsingRef.current = false;
    onSubmit(draft);
  };
  return (
    <div className="btw-compose">
      <div className="btw-inputrow">
        <textarea
          ref={inputRef}
          className="btw-input"
          rows={1}
          placeholder={placeholder}
          value={draft}
          disabled={busy}
          onChange={(e) => {
            browsingRef.current = false;
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
              return;
            }
            // Esc with text: own the double-press clear instead of bubbling to the global
            // routing, which would abort the main turn / arm the tree because it reads the
            // main composer's draft only.
            if (e.key === "Escape") {
              if (!draft.trim()) return;
              e.stopPropagation();
              const now = Date.now();
              if (now - escAtRef.current > DOUBLE_ESC_MS) {
                escAtRef.current = now;
                return;
              }
              escAtRef.current = 0;
              pushInputHistory(historyKey, { text: draft, files: [] });
              setDraft("");
              browsingRef.current = false;
              return;
            }
            // ↑/↓ walk this slot's history; ↑ enters browse only on an empty input, and
            // while browsing the caret has to sit on the edge the direction moves away from.
            if (
              (e.key === "ArrowUp" || e.key === "ArrowDown") &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey &&
              !e.nativeEvent.isComposing
            ) {
              const el = e.currentTarget;
              const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
              const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
              if (!browsingRef.current) {
                if (e.key !== "ArrowUp" || draft.trim() || !atStart) return;
                resetHistoryCursor(historyKey);
                browsingRef.current = true;
              } else if (e.key === "ArrowUp" ? !atStart : !atEnd) {
                return;
              }
              const entry = recallHistory(historyKey, e.key === "ArrowUp" ? 1 : -1);
              if (!entry) return;
              e.preventDefault();
              e.stopPropagation();
              setDraft(entry.text);
              // React rewrites the value on the next render; put the caret at its end then.
              requestAnimationFrame(() => {
                const node = inputRef.current;
                if (node) node.selectionStart = node.selectionEnd = node.value.length;
              });
            }
          }}
        />
        {busy ? (
          // A running topic rejects another turn, so the only honest action here is Stop;
          // queueing would need host support the btw protocol does not have.
          <button className="send stop" onClick={onStop} title={t("right.btwStop")}>
            <Icon name="stopSolid" size={14} />
          </button>
        ) : (
          <button
            className={"send" + (draft.trim() ? " ready" : "")}
            disabled={!draft.trim()}
            onClick={submit}
            title={t("right.btwSend")}
          >
            <Icon name="arrowUp" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: BtwTurn }) {
  const { t } = useTranslation();
  return (
    <div className="btw-turn">
      <div className="btw-u">{turn.question}</div>
      {turn.answer ? (
        <MdSurface className="btw-a md-body md-surface" text={turn.answer} />
      ) : (
        <div className="btw-wait">{turn.status === "running" ? t("right.btwWaiting") : t("right.btwEmptyAnswer")}</div>
      )}
      {turn.status === "error" && <div className="btw-err">{turn.error}</div>}
    </div>
  );
}

function TopicChat({ sessionId, topic, onBack }: { sessionId: string; topic: BtwRecord; onBack(): void }) {
  const { t } = useTranslation();
  const btwSend = useAppStore((s) => s.btwSend);
  const btwCancelTopic = useAppStore((s) => s.btwCancelTopic);
  const btwPromoteTopic = useAppStore((s) => s.btwPromoteTopic);
  // One topic answers at a time: the running turn is the newest follow-up or the opening turn.
  const running = turnsOf(topic).find((turn) => turn.status === "running");
  const scrollRef = useRef<HTMLDivElement>(null);
  const enteredRef = useRef<string | null>(null);

  // Follow the stream only while the reader is at the bottom; opening a topic pins once
  // so a long history lands on its newest turn.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const entered = enteredRef.current !== topic.id;
    enteredRef.current = topic.id;
    if (!entered && el.scrollHeight - el.scrollTop - el.clientHeight > 60) return;
    el.scrollTop = el.scrollHeight;
  }, [topic]);

  return (
    <div className="btw-page">
      <div className="btw-head">
        <button className="icon-btn" title={t("right.backToList")} onClick={onBack}>
          <Icon name="chevronLeft" size={15} />
        </button>
        <span className="btw-head-t" title={topic.question}>
          {topicTitle(topic)}
        </span>
        <span className={"btw-dot" + (running ? " running" : "")} />
        <button
          className="icon-btn"
          title={t("right.btwPromote")}
          disabled={!!running}
          onClick={() => btwPromoteTopic(sessionId, topic.id)}
        >
          <Icon name="fork" size={14} />
        </button>
      </div>
      <div className="btw-scroll" ref={scrollRef}>
        {turnsOf(topic).map((turn, index) => (
          <Turn key={index} turn={turn} />
        ))}
      </div>
      <Composer
        placeholder={t("right.btwPhFollowUp")}
        busy={!!running}
        onSubmit={(text) => btwSend(sessionId, text, topic.id)}
        onStop={() => btwCancelTopic(sessionId, topic.id)}
      />
    </div>
  );
}

function TopicList({
  sessionId,
  topics,
  onOpen,
  onAsk,
}: {
  sessionId: string;
  topics: readonly BtwRecord[];
  onOpen(id: string): void;
  onAsk(text: string): void;
}) {
  const { t } = useTranslation();
  const btwLoad = useAppStore((s) => s.btwLoad);
  return (
    <div className="btw-page">
      <div className="btw-top">
        <span className="btw-top-t">{t("right.tabBtw")}</span>
        <button className="icon-btn" title={t("right.refresh")} onClick={() => btwLoad(sessionId)}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <div className="btw-list">
        {!topics.length && <div className="btw-none">{t("right.btwNoTopics")}</div>}
        {topics.map((topic) => {
          const running = turnsOf(topic).find((turn) => turn.status === "running");
          const turns = turnsOf(topic).length;
          return (
            <button key={topic.id} className="btw-item" onClick={() => onOpen(topic.id)}>
              <span className={"btw-dot" + (running ? " running" : "")} />
              <span className="btw-title" title={topic.question}>
                {topicTitle(topic)}
              </span>
              <span className="btw-meta">
                {turns > 1 && <span className="btw-n">{t("right.btwTurnCount", { n: turns })}</span>}
                <span>{new Date(topic.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </span>
            </button>
          );
        })}
      </div>
      <Composer
        placeholder={t("right.btwPhNew")}
        busy={false}
        autoFocus={!topics.length}
        onSubmit={onAsk}
      />
    </div>
  );
}

export default function BtwPage() {
  const { t } = useTranslation();
  // Side-chat RPCs and frames are keyed by the pool session id (the SDK session UUID),
  // never by the session file path the store uses as its slot key.
  const activeSessionId = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath)?.sessionId : undefined));
  const topics = useAppStore((s) => (activeSessionId ? s.btwTopics.get(activeSessionId) : undefined));
  const btwLoad = useAppStore((s) => s.btwLoad);
  const btwSend = useAppStore((s) => s.btwSend);
  const btwSetDraft = useAppStore((s) => s.btwSetDraft);
  const btwFocus = useAppStore((s) => s.btwFocus);
  const btwFocusTopic = useAppStore((s) => s.btwFocusTopic);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Topic ids that existed before a new-topic ask; the first id outside it is the answer's. */
  const askedFromRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (activeSessionId) btwLoad(activeSessionId);
    // Session switch: drop the open topic and any half-typed text from the previous session.
    setActiveId(null);
    btwSetDraft("");
  }, [activeSessionId, btwLoad, btwSetDraft]);

  // The ask RPC has no topic id in its reply: enter the first topic this session did not
  // know about before the ask. shortcut: an ask that never produces a topic (host error)
  // leaves the guard set until the next ask replaces it.
  useEffect(() => {
    const known = askedFromRef.current;
    if (!known || !topics) return;
    const fresh = topics.find((topic) => !known.has(topic.id));
    if (!fresh) return;
    askedFromRef.current = null;
    setActiveId(fresh.id);
  }, [topics]);

  // /btw <question> has the host name its topic in open_right_tab; enter it once the topic
  // list holds it (the btw_record checkpoint may arrive before the panel mounts).
  useEffect(() => {
    if (!btwFocus || !topics?.some((topic) => topic.id === btwFocus)) return;
    btwFocusTopic(null);
    setActiveId(btwFocus);
  }, [btwFocus, topics, btwFocusTopic]);

  // Bare /btw: show the directory of the session the command ran in (btwRootSeq is a
  // one-shot signal, so this must not depend on activeSessionId).
  const btwRootSeq = useAppStore((s) => s.btwRootSeq);
  useEffect(() => {
    if (!btwRootSeq) return;
    setActiveId(null);
    btwSetDraft("");
  }, [btwRootSeq, btwSetDraft]);

  if (!activeSessionId) {
    return (
      <div className="btw-page">
        <div className="btw-none">{t("right.noActiveSession")}</div>
      </div>
    );
  }

  const active = activeId ? topics?.find((topic) => topic.id === activeId) : undefined;
  if (active) {
    return (
      <TopicChat
        sessionId={activeSessionId}
        topic={active}
        onBack={() => {
          setActiveId(null);
          btwSetDraft("");
        }}
      />
    );
  }
  return (
    <TopicList
      sessionId={activeSessionId}
      topics={topics ?? []}
      onOpen={(id) => {
        btwSetDraft("");
        setActiveId(id);
      }}
      onAsk={(text) => {
        askedFromRef.current = new Set((topics ?? []).map((topic) => topic.id));
        btwSend(activeSessionId, text);
      }}
    />
  );
}
