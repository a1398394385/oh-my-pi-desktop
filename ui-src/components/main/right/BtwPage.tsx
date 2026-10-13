// /btw side-conversation page: topic list (newest first) + expandable Q/A turns + composer.
// Multiple topics answer concurrently; within one topic turns are serialized by the host.
// The composer either starts a new topic or follows up in `btwReplyTo`.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import Icon from "../../../Icon";
import MdSurface from "../../chat/MdSurface";
import type { BtwRecord, BtwTurn } from "../../../types/frames";

/** The topic is mid-answer when its opening turn or any follow-up is still running. */
function runningTurnOf(topic: BtwRecord): BtwTurn | undefined {
  const turns = topic.followUps?.length ? topic.followUps : [topic];
  return turns.find((turn) => turn.status === "running");
}

function topicTitle(topic: BtwRecord): string {
  const firstLine = topic.question.split("\n")[0] ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

function turnCount(topic: BtwRecord): number {
  return 1 + (topic.followUps?.length ?? 0);
}

function TurnRow({ turn }: { turn: BtwTurn }) {
  const { t } = useTranslation();
  return (
    <div className="btw-turn">
      <div className="btw-q">{turn.question}</div>
      {turn.answer ? (
        <MdSurface className="btw-a md-surface" text={turn.answer} />
      ) : (
        <div className="btw-empty">{t("right.btwEmptyAnswer")}</div>
      )}
      {turn.status === "error" && <div className="btw-err">{turn.error}</div>}
    </div>
  );
}

function TopicCard({
  sessionId,
  topic,
  open,
  onToggle,
  onFollowUp,
}: {
  sessionId: string;
  topic: BtwRecord;
  open: boolean;
  onToggle(): void;
  onFollowUp(): void;
}) {
  const { t } = useTranslation();
  const running = runningTurnOf(topic);
  const btwCancelTopic = useAppStore((s) => s.btwCancelTopic);
  const btwPromoteTopic = useAppStore((s) => s.btwPromoteTopic);
  const time = new Date(topic.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={"btw-card" + (running ? " running" : "") + (open ? " open" : "")}>
      <div className="srow btw-row" onClick={onToggle}>
        <span className={"btw-dot" + (running ? " running" : "")} />
        <span className="btw-title" title={topic.question}>{topicTitle(topic)}</span>
        <span className="btw-meta">
          {turnCount(topic) > 1 && <span className="btw-n">{t("right.btwTurnCount", { n: turnCount(topic) })}</span>}
          <span>{time}</span>
        </span>
        <span className="btw-acts" onClick={(e) => e.stopPropagation()}>
          {!running && (
            <>
              <button className="icon-btn" onClick={onFollowUp} title={t("right.btwFollowUp")}>
                <Icon name="comment" size={13} />
              </button>
              <button className="icon-btn" onClick={() => btwPromoteTopic(sessionId, topic.id)} title={t("right.btwPromote")}>
                <Icon name="fork" size={13} />
              </button>
            </>
          )}
          {running && (
            <button className="icon-btn" onClick={() => btwCancelTopic(sessionId, topic.id)} title={t("right.btwStop")}>
              <Icon name="xmark" size={13} />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="btw-body">
          {(topic.followUps?.length ? [topic, ...topic.followUps] : [topic]).map((turn, i) => (
            <TurnRow key={i} turn={turn} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function BtwPage() {
  const { t } = useTranslation();
  // Side-chat RPCs and frames are keyed by the pool session id (the SDK session UUID),
  // never by the session file path the store uses as its slot key.
  const activeSessionId = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath)?.sessionId : undefined));
  const topics = useAppStore((s) => (activeSessionId ? s.btwTopics.get(activeSessionId) : undefined));
  const draft = useAppStore((s) => s.btwDraft);
  const replyTo = useAppStore((s) => s.btwReplyTo);
  const btwLoad = useAppStore((s) => s.btwLoad);
  const btwSend = useAppStore((s) => s.btwSend);
  const btwSetDraft = useAppStore((s) => s.btwSetDraft);
  const btwReplyToTopic = useAppStore((s) => s.btwReplyToTopic);
  const [openId, setOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (activeSessionId) btwLoad(activeSessionId);
    // Session switch: reset the expansion and reply target to the new session's own state
    setOpenId(null);
    btwReplyToTopic(null);
  }, [activeSessionId, btwLoad, btwReplyToTopic]);

  // A running topic auto-expands so streaming stays visible; the user's manual pick wins otherwise
  const autoRunningId = topics?.find((topic) => runningTurnOf(topic))?.id;
  useEffect(() => {
    if (autoRunningId) setOpenId(autoRunningId);
  }, [autoRunningId]);

  if (!activeSessionId) return <div className="btw-page"><div className="btw-none">{t("right.noActiveSession")}</div></div>;

  const replyTarget = replyTo ? topics?.find((topic) => topic.id === replyTo) : undefined;
  const send = () => btwSend(activeSessionId, draft);

  return (
    <div className="btw-page">
      <div className="btw-top">
        <span className="btw-top-t">{t("right.tabBtw")}</span>
        <button
          className="icon-btn"
          title={t("right.btwNewTopic")}
          onClick={() => {
            btwReplyToTopic(null);
            inputRef.current?.focus();
          }}
        >
          <Icon name="messagePlus" size={15} />
        </button>
        <button className="icon-btn" title={t("right.refresh")} onClick={() => btwLoad(activeSessionId)}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <div className="btw-list">
        {!topics?.length && <div className="btw-none">{t("right.btwNoTopics")}</div>}
        {topics?.map((topic) => (
          <TopicCard
            key={topic.id}
            sessionId={activeSessionId}
            topic={topic}
            open={openId === topic.id || !!runningTurnOf(topic)}
            onToggle={() => setOpenId(openId === topic.id ? null : topic.id)}
            onFollowUp={() => {
              btwReplyToTopic(topic.id);
              setOpenId(topic.id);
              inputRef.current?.focus();
            }}
          />
        ))}
      </div>
      <div className="btw-compose">
        {replyTarget && (
          <div className="btw-replybar">
            <span className="btw-reply-t" title={replyTarget.question}>{topicTitle(replyTarget)}</span>
            <button className="icon-btn" onClick={() => btwReplyToTopic(null)} title={t("right.btwNewTopic")}>
              <Icon name="xmark" size={11} />
            </button>
          </div>
        )}
        <div className="btw-inputrow">
          <textarea
            ref={inputRef}
            className="btw-input"
            rows={1}
            placeholder={replyTarget ? t("right.btwPhFollowUp") : t("right.btwPhNew")}
            value={draft}
            onChange={(e) => btwSetDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="icon-btn btw-send" disabled={!draft.trim()} onClick={send} title={t("right.btwSend")}>
            <Icon name="arrowUp" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
