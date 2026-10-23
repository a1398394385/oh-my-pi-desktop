// Composer area: attachment row + Lexical editor + cbar (add / permission mode /
// background tasks / subagents / context ring / model / think / send) + three popup
// menus + sigil completion panel. Migrated from ui/composer.js (578 lines); Lexical
// based since P7 (RichText + History + TypeaheadMenuPlugin).
// Contract: draft is a module-level singleton (EditorState snapshot + flattened plain
// text, see composer/lexical/draft.ts; switching between the welcome and dock mount
// slots never loses it); composerSetSignal (seq signal) backfilled by effect (images
// included); send/stop unified (streaming with no draft -> stop); model/think menus
// read modelNames/modelEfforts from the store; accepting a completion inserts a
// ChipNode (decorator atom node) whose serialized text is byte-identical to the old
// textarea insertion, and the editor flattened view (composer/lexical/flat.ts) keeps
// the prompt content format sent over WS unchanged.
// Queue card does not live here: App renders it as an adjacent sibling before .dock
// (ZCode-style negative-margin two-level stacked card, see ui/style.css).
import { useEffect, useLayoutEffect, useReducer, useRef, useState, useMemo, useCallback } from "react";
import type { ChangeEvent, MouseEvent, Ref } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, toast } from "../store";
import { bgJobsKey } from "../store/session";
import { invoke } from "../store/ws";
import { expandRightPanel } from "./main/right/tabs";
import type { PromptAttachment } from "../types/frames";
import { closeAllMenus, motionEnabled } from "../shell";
import Icon from "../Icon";
import AttachRow from "./composer/AttachRow";
import ModeMenu, { MODE_META, SMART_MODE } from "./composer/ModeMenu";
import ModelMenu from "./composer/ModelMenu";
import PaletteMenu from "./composer/PaletteMenu";
import type { PaletteItem } from "./composer/PaletteMenu";
import { detectTrigger, isBashMode, insertFile, insertCommand } from "./composer/trigger";
import { filterCommands, filterSkills, filterSubcommands } from "./composer/completionFilters";
import { bgTaskCount, subagentCount } from "./composer/sessionCounts";
import { sendComposerPrompt } from "./composer/send";
import CtxCard from "./chat/CtxCard";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import BashCompletePlugin from "./composer/lexical/BashCompletePlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import type { TriggerFn, MenuRenderFn } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { TextNode, LexicalNode } from "lexical";
import { $createChipNode, ChipNode, $isChipNode } from "./composer/lexical/ChipNode";
import { GhostNode } from "./composer/lexical/GhostNode";
import GhostTextPlugin from "./composer/lexical/GhostTextPlugin";
import { $flattenWithCaret, $leafStart, $selectAfter } from "./composer/lexical/flat";
import {
  getDraftState,
  getDraftText,
  getDraftFiles,
  saveDraftFiles,
  clearDraftState,
  pushInputHistory,
  CONTENT_EDITABLE_OK,
} from "./composer/lexical/draft";
import ComposerPlugin from "./composer/lexical/ComposerPlugin";
import type { ComposerHandle } from "./composer/lexical/ComposerPlugin";
import { setTtsDuck } from "../lib/speechOut";

// Size cap for attachments to send: images go through ImageContent (base64),
// text-like files are inlined into the prompt
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

// Provider sigils (copied from ui/settings/index.js PROV_IC; that module has
// settings-page binding side effects at top level, so importing it is not viable)
const PROV_IC: Record<string, string> = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };

// Context ring circumference: 2*pi*7 (matches the CSS dasharray)
const RING_C = 43.98;

// Max stage of the bottom-bar graded collapse (permission mode/think/model ->
// icon only, hide subagents, hide background tasks, three pills icon-only +
// tight padding, hide plan pill + mic/screen buttons)
const BAR_STAGES = 7;

// Remote-control browser client (spec §4.1): no Tauri bridge and not the
// ?preview=1 ui:dev sample page; a ?ws= dev direct-connect is a local channel
// instead (.has() form kept identical to ws.ts/layout.ts). The mic/STT path
// needs a secure context, so remote never renders the voice button and
// voiceMode reads as false.
const REMOTE =
  !invoke && !new URLSearchParams(location.search).has("preview") && !new URLSearchParams(location.search).has("ws");

// Build the attachment payload sent along with the prompt (caller clears
// pendingFiles after sending)
function buildAttachPayload(): PromptAttachment[] {
  return useAppStore
    .getState()
    .pendingFiles.map((f) =>
      f.kind === "image"
        ? { kind: "image", mime: f.mime, data: f.data }
        : { kind: "text", name: f.name, text: f.data },
    );
}

type MenuName = "mode" | "model";

// Typeahead option wrapper: data carries the raw candidate (FileItem /
// CommandItem), key takes path / name
class PalOption extends MenuOption {
  data: PaletteItem;
  constructor(data: PaletteItem) {
    super("path" in data ? data.path : data.name);
    this.data = data;
  }
}

type ComposerProps = {
  inWelcome: boolean;
  blocking?: boolean;
};

export default function Composer({ inWelcome, blocking = false }: ComposerProps) {
  const { t } = useTranslation();
  // ---- store subscriptions (field-by-field selectors; constructing new
  // objects/arrays inside selectors is forbidden) ----
  // Active session fields (Batch 1): the former whole-session selector re-rendered the
  // composer on every updateSession of the active session; these scalars (and the two
  // count selectors below) re-render only when a value the bar actually shows flips.
  // Nested objects (ctx/model) are replaced wholesale on write, so picking them by
  // reference is safe.
  const activePath = useAppStore((st) => st.activePath);
  const draftKey = inWelcome ? "welcome" : (activePath || "welcome");
  const hasSession = useAppStore((st) => (st.activePath ? st.openSessions.has(st.activePath) : false));
  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const streaming = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.streaming ?? false : false));
  const isSubagent = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.isSubagent ?? false : false));
  const model = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.model : undefined));
  const thinking = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.thinking : undefined));
  const autoResolved = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.autoResolved : undefined));
  const planMode = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.planMode ?? false : false));
  const computerMode = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.computerMode ?? false : false));
  const pendingFiles = useAppStore((st) => st.pendingFiles);
  const escArmedUntil = useAppStore((st) => st.escArmedUntil);
  const composerSetSignal = useAppStore((st) => st.composerSetSignal);
  const commandFlash = useAppStore((st) => st.commandFlash);
  const menuSignal = useAppStore((st) => st.menuSignal);
  const isCreatingNew = useAppStore((st) => st.isCreatingNew);
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const newSessionThinking = useAppStore((st) => st.newSessionThinking);
  const newSessionPlanMode = useAppStore((st) => st.newSessionPlanMode);
  const newSessionComputerMode = useAppStore((st) => st.newSessionComputerMode);
  const computerGateOn = useAppStore((st) => st.hostSettings?.computerEnabled === true);
  // Kimi provider: the same screen-icon button mounts the kimi-cu MCP server
  // per session, so it must be visible whenever KimiCU is installed — even
  // with the builtin master switch off (that switch only gates the builtin)
  const kimiProviderOn = useAppStore(
    (st) => st.hostSettings?.computerProvider === "kimi" && st.hostSettings?.kimiCuInstalled === true,
  );
  const computerIconOn = computerGateOn || kimiProviderOn;
  // Voice conversation mode = synthesis + dictation switches both on; the mic
  // button toggles them together and lights while they hold. Remote clients
  // have no microphone (http is not a secure context): voiceMode reads false
  const voiceModeOn = useAppStore(
    (st) => st.hostSettings?.values?.["speech.enabled"] === true && st.hostSettings?.values?.["stt.enabled"] === true,
  );
  const voiceMode = !REMOTE && voiceModeOn;
  const voiceStt = useAppStore((st) => st.voiceStt);
  const sttSubmitSignal = useAppStore((st) => st.sttSubmitSignal);
  const lastSubmitSeqRef = useRef(0);
  const commands = useAppStore((st) => st.commands);
  const mentionResult = useAppStore((st) => st.mentionResult);
  const approvalMode = useAppStore((st) => st.approvalMode);
  const rightCollapsed = useAppStore((st) => st.rightCollapsed);
  const rightTab = useAppStore((st) => st.rightTab);
  // No-assignment subscription: the model catalog swaps its Map reference when the
  // models/ready frame arrives, so subscribing to the reference re-renders after a
  // catalog refresh (modelShort below reads the latest table via getState).
  // commandsSessionId and commands are written in the same frame (ws.ts
  // list_commands reply); ownership is decided on the spot via getState inside
  // onQueryChange
  useAppStore((st) => st.modelNames);

  const rootRef = useRef<HTMLDivElement>(null); // #composer
  const [ctxRingEl, setCtxRingEl] = useState<HTMLSpanElement | null>(null); // #ctxRing element (callback ref; hover attaches even when the ring renders later)
  const lexRef = useRef<ComposerHandle | null>(null); // editor handle (focus/setText/clear)
  const cbarRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null); // filePicker
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null); // "mode" | "model" | null (mutually exclusive)
  const [stopPending, setStopPending] = useState(false); // stop-button double-click guard (reset on turn_end)
  const barStageRef = useRef(0); // last collapse stage (close open menus when it changes)
  // Push-to-talk: the press arms a 180ms timer — a quick tap never reaches
  // stt_start (its click toggles the voice mode); holding past the timer
  // starts dictation and the release click is swallowed
  const PTT_DELAY_MS = 180;
  const pttTimerRef = useRef<number | undefined>(undefined);
  const pttDownRef = useRef(false);
  const holdTalkRef = useRef(false);
  const beginMicTalk = () => {
    if (pttTimerRef.current !== undefined) return;
    pttTimerRef.current = window.setTimeout(() => {
      pttTimerRef.current = undefined;
      pttDownRef.current = true;
      setTtsDuck(true);
      send({ type: "stt_start", sessionId: sessionId ?? "", anchor: getDraftText(draftKey) });
    }, PTT_DELAY_MS);
  };
  const endMicTalk = () => {
    if (pttTimerRef.current !== undefined) {
      // Released before the delay: a quick tap, let the click toggle the mode
      clearTimeout(pttTimerRef.current);
      pttTimerRef.current = undefined;
      return;
    }
    pttDownRef.current = false;
    setTtsDuck(false);
    holdTalkRef.current = true;
    send({ type: "stt_stop" });
  };

  // Unmount safety: a pending press timer must not fire stt_start after the composer is gone
  useEffect(() => () => clearTimeout(pttTimerRef.current), []);

  // refreshes the send button ready state and the bash-mode class, equivalent to the
  // notify/forceRender in the old onInput
  const [text, setText] = useState(() => getDraftText(draftKey));
  const onTextChange = useCallback((t: string) => setText(t), []);

  // ---- sigil completion panel (TypeaheadMenuPlugin controlled state) ----
  const [taKind, setTaKind] = useState<"file" | "command" | "commandArgs" | "skill" | null>(null); // trigger kind (while open)
  const [taCommand, setTaCommand] = useState(""); // typed command name (commandArgs triggers; empty otherwise)
  const [taQuery, setTaQuery] = useState("");
  const [taReqId, setTaReqId] = useState(0); // @ candidate request sequence (paired with mentionResult.reqId)
  const [taOpen, setTaOpen] = useState(false); // panel open/close (for yielding to keyboard commands)
  const taOpenRef = useRef(false);
  useEffect(() => {
    taOpenRef.current = taOpen;
  }, [taOpen]);
  // Close channel: TypeaheadMenuPlugin has no controlled close, so remount via key
  // clears the resolution; also reset the open flag and the dedupe key (reopen =
  // re-trigger = re-request, aligned with the old setPalette(null) semantics)
  const [closeTick, bumpClose] = useReducer((x: number) => x + 1, 0);
  const closeTypeahead = useCallback(() => {
    if (!taOpenRef.current) return;
    taOpenRef.current = false;
    setTaOpen(false);
    lastKeyRef.current = null;
    bumpClose();
  }, []);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // @ candidate 150ms debounce
  // kind/quoted of the most recent trigger (written by triggerFn, read by
  // onQueryChange/onSelectOption); command carries the typed slash-command
  // name for commandArgs triggers
  const lastTriggerRef = useRef<{ kind: "file" | "command" | "commandArgs" | "skill"; quoted: boolean; command?: string } | null>(null);
  // Trigger-state dedupe key: Lexical's updateListener also fires onQueryChange
  // for selection-only updates; the same trigger state runs the request side
  // effect only once (aligned with the old updatePalette running only on text input)
  const lastKeyRef = useRef<string | null>(null);

  // ---- Attachment isolation and restore (restore from draft on mount, save to
  // draft on change) ----
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    useAppStore.setState({ pendingFiles: getDraftFiles(draftKey) });
    // Both the draft mirror and the editor content follow slot switches: the
    // useState initial value is evaluated only for the first draftKey, while the
    // Lexical editor instance is reused across draftKeys (initialConfig.editorState
    // takes effect only once); without syncing, stale text from the previous slot
    // lingers -- and gets written into the new slot by updateListener
    // (cross-session draft leak + ready state stuck on)
    setText(getDraftText(draftKey));
    lexRef.current?.setText(getDraftText(draftKey));
    restoredRef.current = true;
  }, [draftKey]);

  useEffect(() => {
    if (!restoredRef.current) return;
    saveDraftFiles(draftKey, pendingFiles);
  }, [draftKey, pendingFiles]);

  const hasDraft = text.trim().length > 0 || pendingFiles.length > 0;
  // Running local bash row (!-prefixed command): the stop form covers it too --
  // clicking stop sends bash_abort instead of abort_session
  // Any in-flight local bash row (scalar selector: the boolean flips only on bash start/done,
  // not on every item write)
  const bashRunning = useAppStore((st) => {
    const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (!sess) return false;
    for (const it of sess.items) {
      if (it.role === "bash" && it.running) return true;
    }
    return false;
  });
  const stopping = (streaming || bashRunning) && !hasDraft;
  // Inside the Esc double-confirm window: with a draft the send button briefly
  // shows the cancel icon (pressing Esc again interrupts generation)
  const escArmed = Date.now() < (escArmedUntil ?? 0);
  const canAbort = stopping || escArmed;

  // ---- External backfill signal (fork selectedText / queued message edit),
  // aligned with the old setComposerValue (images included) ----
  useEffect(() => {
    const sig = composerSetSignal;
    if (!sig || !lexRef.current) return;
    // guard = async backfill (fork/jump reply): if the user typed a new draft
    // during the RPC round trip, skip the overwrite -- the user's new intent wins
    // (aligned with PI-Desktop #934 "the completion callback owns only the draft
    // it submitted")
    if (sig.guard && (getDraftText(draftKey).trim() || useAppStore.getState().pendingFiles.length)) {
      useAppStore.setState({ composerSetSignal: null });
      return;
    }
    if (!sig.text && (!sig.images || sig.images.length === 0)) {
      lexRef.current.clear();
      useAppStore.setState({ pendingFiles: [], composerSetSignal: null });
      lexRef.current.focus();
      return;
    }
    lexRef.current.setText(sig.text);
    // Convert base ImageContent[] to local attachment chips: field shape
    // { type:"image", data, mimeType }, nested source shape tolerated
    interface BackfillImage {
      name?: string;
      data?: string;
      mimeType?: string;
      mediaType?: string;
      source?: { type?: string; data?: string; mimeType?: string; mediaType?: string };
    }
    // Shape follows the base SDK (frames.ts selectedImages/editorImages TODO);
    // only constrain the fields this effect reads
    const backfillImages = (sig.images ?? []) as BackfillImage[];
    // Attachment append + signal reset + render trigger merged into one setState
    // (pendingFiles container gets a new reference; ids continue from the store's
    // current fileSeq, equivalent to the old per-item ++fileSeq)
    useAppStore.setState((st) => {
      const files = [...st.pendingFiles];
      let seq = st.fileSeq;
      for (const img of backfillImages) {
        const src = img.source?.type === "base64" ? img.source : img;
        if (!src?.data) continue;
        files.push({
          id: ++seq,
          name: img.name || t("composer.imageN", { n: files.length + 1 }),
          kind: "image",
          mime: src.mimeType || src.mediaType || "image/png",
          data: src.data,
        });
      }
      return { pendingFiles: files, fileSeq: seq, composerSetSignal: null };
    });
    lexRef.current.focus();
  });

  // ---- Mount slot switch (welcome <-> dock rebuilds the instance): focus on welcome ----
  useLayoutEffect(() => {
    if (inWelcome) lexRef.current?.focus();
  }, [inWelcome]);

  // ---- Sync draft presence to the store (global Esc double-confirm needs to
  // know whether the composer has content) ----
  useEffect(() => {
    // Silent write (no bump: the old code had no notify after the write; with bump
    // it would render-loop)
    useAppStore.setState({ draftHasContent: hasDraft });
  });

  // ---- Send path: the pipeline lives in composer/send.ts (store-level, sunk by
  // A14); the component only hands in the draft text + attachments and clears its
  // editor state when the dispatch succeeded ----
  const needSessionMsg = t("composer.needSession"); // currently unconsumed (pre-existing dead code, kept as-is)
  const clearDraft = () => {
    lexRef.current?.clear();
    clearDraftState(draftKey);
    // Sync the mirror directly: Lexical clear() triggers updateListener
    // asynchronously, by then the slot is already emptied and the changed check
    // (empty===empty) skips onTextChange, leaving the sent text behind in `text`
    setText("");
    setBump({ pendingFiles: [] });
  };
  const sendPrompt = (steer = false) => {
    // Sent prompts join the slot's input history (browsable with ↑ on an
    // empty input); push before clearDraft empties the slot's draft mirror.
    // The welcome/creating-new first send is deferred (pendingNew* intents):
    // its entry lands in the created session's slot in the session_created
    // handler, not the welcome slot.
    if (sendComposerPrompt({ raw: getDraftText(draftKey), files: buildAttachPayload(), steer })) {
      const st = useAppStore.getState();
      const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
      if (s && !st.isCreatingNew && st.hostSettings?.values?.["composer.recallClearedDrafts"] !== false) {
        pushInputHistory(draftKey);
      }
      clearDraft();
    }
  };

  // ---- sigil trigger detection (triggerFn): global flattened view +
  // detectTrigger, semantics identical to the detection section of the old
  // updatePalette (command/skill lists need a session or the creating-new
  // page); the trigger range must fall entirely inside the anchor
  // text node (Typeahead locates the replacement range by in-node offsets) ----
  const triggerFn = useCallback<TriggerFn>(
    (_text, editor) =>
      editor.read(() => {
        const fail = () => {
          lastTriggerRef.current = null;
          return null;
        };
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return fail();
        const anchor = sel.anchor;
        if (anchor.type !== "text") return fail();
        const node = anchor.getNode();
        if (!$isTextNode(node) || !node.isSimpleText()) return fail();
        const { text: full, caret } = $flattenWithCaret();
        if (caret == null) return fail();
        const t = detectTrigger(full, caret);
        if (!t) return fail();
        if (t.kind !== "file") {
          const st = useAppStore.getState();
          const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
          if (sess?.isSubagent && (t.kind === "command" || t.kind === "commandArgs")) return fail(); // subagents do not support slash commands
          if (!sess && !st.isCreatingNew) return fail(); // no session and not creating-new: commands unavailable
          // Subcommand completion only applies to commands that declared
          // subcommands; a null list (not fetched yet) stays eligible so the
          // panel can show loading and onQueryChange fetches the list
          if (t.kind === "commandArgs") {
            const list = st.commands;
            const cmd = list?.find((c) => c.name === t.command || c.aliases?.includes(t.command));
            if (list && (!cmd || !cmd.subcommands.length)) return fail();
          }
        }
        const nodeStart = $leafStart(node);
        if (nodeStart == null || t.start < nodeStart) return fail();
        lastTriggerRef.current = {
          kind: t.kind,
          quoted: t.kind === "file" ? !!t.quoted : false,
          command: t.kind === "commandArgs" ? t.command : undefined,
        };
        return { leadOffset: t.start - nodeStart, matchingString: t.query, replaceableString: full.slice(t.start, t.end) };
      }),
    [],
  );

  // ---- Post-trigger request side effect (onQueryChange): slash command list
  // fetch / @ file candidates with 150ms debounce, ported from the request
  // section of the old updatePalette (including the silent commands:null write
  // and reqId increment to drop stale responses) ----
  const onQueryChange = useCallback((q: string | null) => {
    const trig = lastTriggerRef.current;
    const key = q == null || !trig ? null : `${trig.kind}${trig.command ? ":" + trig.command : ""}|${trig.quoted ? 1 : 0}|${q}`;
    if (key === lastKeyRef.current) return; // repeated update for the same trigger state: idempotent skip of side effects
    lastKeyRef.current = key;
    if (!trig || q == null) return;
    setTaKind(trig.kind);
    setTaQuery(q);
    setTaCommand(trig.command ?? "");
    const st = useAppStore.getState();
    const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (trig.kind !== "file") {
      // List ownership: session id or the creating-new sentinel (creating-new uses
      // the sessionless list, hiding session-level commands)
      const cmdKey = sess ? sess.sessionId : "new";
      if (st.commandsSessionId !== cmdKey) {
        useAppStore.setState({ commands: null }); // list stale: popup shows loading during fetch
        send({ type: "list_commands", sessionId: sess?.sessionId, cwd: sess ? undefined : st.newSessionProject || undefined });
      }
    } else {
      // @ file candidates: send list_files after a 150ms debounce (the host
      // fuzzyFind is a disk scan)
      const reqId = st.mentionReqSeq + 1;
      useAppStore.setState({ mentionReqSeq: reqId }); // silent increment (the old code did ++ without notify)
      const cwd = sess ? undefined : st.newSessionProject || undefined;
      clearTimeout(mentionTimer.current ?? undefined);
      mentionTimer.current = setTimeout(() => {
        send({ type: "list_files", sessionId: sess?.sessionId, cwd, query: q, reqId });
      }, 150);
      setTaReqId(reqId);
    }
  }, []);

  // Candidates and loading state are computed from the store at render time (the
  // file_matches/commands replies setState and trigger a re-render); no snapshot
  // is stored -- candidates appear the moment the reply frame arrives, no extra
  // keystroke needed
  const taItems: PaletteItem[] =
    taKind === "file"
      ? mentionResult && mentionResult.reqId === taReqId
        ? mentionResult.matches
        : []
      : taKind === "command"
        ? filterCommands(commands, taQuery)
        : taKind === "commandArgs"
          ? filterSubcommands(commands?.find((c) => c.name === taCommand || c.aliases?.includes(taCommand))?.subcommands, taQuery)
        : taKind === "skill"
          ? filterSkills(commands, taQuery)
          : [];
  const taLoading =
    taKind === "file" ? !(mentionResult && mentionResult.reqId === taReqId) : taKind === "command" || taKind === "commandArgs" || taKind === "skill" ? commands === null : false;
  const taOptions = taItems.map((it) => new PalOption(it));

  // ---- Accepting a completion: file -> ChipNode (serialization = insertFile
  // verbatim); command/skill -> ChipNode (insertCommand; a skill entry's name is
  // "skill:<name>", so the chip text is "/skill:<name> " which the host
  // dispatches); directory -> plain-text replacement with
  // the caret parked at the token tail (no trailing space), triggerFn recomputes
  // the trigger after update and chains into that directory's contents (aligned
  // with the old dispatchEvent(input) trigger recompute; after a chip the anchor
  // is an element node, text-level typeahead can no longer trigger, so directory
  // chaining must go through plain text) ----
  const onSelectOption = useCallback((option: PalOption, node: TextNode | null, closeMenu: () => void) => {
    // A null node with a live trigger is the empty-query corner: Lexical's
    // $splitNodeContainingQuery returns undefined when startOffset equals the
    // selection offset (splitText(o, o)); only the commandArgs branch needs
    // the fallback (file/command/skill close as before)
    const trig = lastTriggerRef.current;
    if (!trig || (!node && trig.kind !== "commandArgs")) {
      closeMenu();
      return;
    }
    const it = option.data;
    if (trig.kind === "file") {
      if (!node) {
        closeMenu(); // unreachable via the guard above; keeps the narrowing explicit
        return;
      }
      if (!("path" in it)) {
        closeMenu(); // type guard: candidates must be FileItem when kind=file
        return;
      }
      const next = insertFile(it.path, it.dir, trig.quoted);
      if (it.dir) {
        node.setTextContent(next);
        node.select(next.length, next.length);
      } else {
        const chip = $createChipNode(next);
        node.replace(chip);
        $selectAfter(chip);
      }
    } else if (trig.kind === "commandArgs") {
      if (!("name" in it)) {
        closeMenu(); // type guard: candidates must be CommandItem when kind=commandArgs
        return;
      }
      // The accepted subcommand merges with the typed command into ONE chip
      // ("/memory view ") so the highlight renders as a single unit: absorb
      // the left neighbor — the command chip (chip-after-chip path), or the
      // hand-typed "/memory" text node — into the merged chip text. Empty
      // query: no split node exists, so resolve the replacement target from
      // the collapsed caret's anchor text node; that is the one-space tail
      // node the auto-opened palette parked the caret in (absorbing the
      // neighbor also collapses the doubled whitespace).
      let target: TextNode | null = node;
      if (!target) {
        const sel = $getSelection();
        const anchor = $isRangeSelection(sel) && sel.isCollapsed() ? sel.anchor : null;
        const anchorNode = anchor?.type === "text" ? anchor.getNode() : null;
        target = anchorNode && $isTextNode(anchorNode) && anchorNode.isSimpleText() ? anchorNode : null;
      }
      if (!target) {
        closeMenu();
        return;
      }
      let text = it.name + " ";
      let absorbAt: LexicalNode | null = null; // the node whose text folds into the merged chip
      const skipped: LexicalNode[] = []; // pure-whitespace nodes between the query and the command prefix
      let scan: LexicalNode | null = target.getPreviousSibling();
      while (scan && $isTextNode(scan) && scan.getTextContent().trim() === "") {
        skipped.push(scan);
        scan = scan.getPreviousSibling();
      }
      if (scan && $isChipNode(scan)) {
        absorbAt = scan;
      } else if (scan && $isTextNode(scan) && scan.getTextContent().trimEnd().toLowerCase().endsWith("/" + trig.command)) {
        absorbAt = scan;
      }
      if (absorbAt) {
        // Keep the user's original casing in the merged chip text
        text = absorbAt.getTextContent().trimEnd() + " " + text;
      }
      const chip = $createChipNode(text);
      target.replace(chip);
      absorbAt?.remove();
      for (const sk of skipped) sk.remove();
      if (!absorbAt) {
        // Merge did not apply (no recognizable command prefix at the left):
        // keep the separator space a hand-typed query relied on
        const left = chip.getPreviousSibling();
        if (left && $isTextNode(left) && !/\s$/.test(left.getTextContent())) {
          chip.insertBefore($createTextNode(" "));
        }
      }
      $selectAfter(chip);
    } else {
      if (!node) {
        closeMenu(); // unreachable via the guard above; keeps the narrowing explicit
        return;
      }
      if (!("name" in it)) {
        closeMenu(); // type guard: candidates must be CommandItem when kind=command/skill
        return;
      }
      const chip = $createChipNode(insertCommand(it.name));
      node.replace(chip);
      // Commands with declared subcommands: park the caret inside a one-space
      // text node right after the chip instead of the element slot. An empty
      // text node is not viable (Lexical normalizes it away into a managed
      // line break); the extra space is inert on every consumer --
      // detectTrigger's \s+ swallows the doubled whitespace and the host's
      // parseSlashCommand splits on \s+ -- while the text anchor lets
      // triggerFn's next run (this very update) resolve a commandArgs trigger
      // and open the subcommand palette immediately. Commands without
      // subcommands keep the plain post-chip caret (nothing to complete).
      const hasSubcommands = (useAppStore.getState().commands ?? []).some(
        (c) => c.name === it.name && c.subcommands.length > 0,
      );
      if (hasSubcommands) {
        const tail = $createTextNode(" ");
        chip.insertAfter(tail);
        tail.select(1, 1);
      } else {
        $selectAfter(chip);
      }
    }
    closeMenu();
  }, []);

  // Panel rendering: reuses PaletteMenu (.menu/.mi visuals + placePaletteCard
  // anchoring the card above #composer, pixel-identical to the old version);
  // navigation/highlight/accept go through the plugin-provided itemProps
  const menuRenderFn: MenuRenderFn<PalOption> = (_anchorRef, itemProps) => (
    <PaletteMenu
      mode={taKind ?? "file"}
      items={taItems}
      index={itemProps.selectedIndex ?? 0}
      loading={taLoading}
      composerRef={rootRef}
      onPick={(i) => {
        const opt = itemProps.options[i];
        if (opt) itemProps.selectOptionAndCleanUp(opt);
      }}
      onHover={(i) => itemProps.setHighlightedIndex(i)}
    />
  );
  const onTaOpen = useCallback(() => setTaOpen(true), []);
  const onTaClose = useCallback(() => setTaOpen(false), []);

  // ---- Attachment handling: pick files / paste screenshots / drag-drop files into the list ----
  const addIncomingFiles = useCallback(async (picked: File[]) => {
    const added: (PromptAttachment & { id: number })[] = [];
    for (const file of picked) {
      if (file.size > MAX_ATTACH_BYTES) {
        toast(t("composer.oversizeFile", { name: file.name }));
        continue;
      }
      try {
        if (file.type.startsWith("image/")) {
          const dataUrl = await new Promise<string>((ok, no) => {
            const r = new FileReader();
            r.onload = () => ok(r.result as string); // readAsDataURL result is always a dataURL string
            r.onerror = () => no(r.error);
            r.readAsDataURL(file);
          });
          const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
          added.push({ id: 0, name: file.name, kind: "image", mime: file.type, data: b64 });
        } else {
          added.push({ id: 0, name: file.name, kind: "text", mime: file.type || "text/plain", data: await file.text() });
        }
      } catch {
        toast(t("composer.readFail", { name: file.name }));
      }
    }
    if (added.length === 0) return;
    // Attachment append + render trigger merged into one setState (pendingFiles
    // container gets a new reference)
    useAppStore.setState((st) => {
      let seq = st.fileSeq;
      const files = [...st.pendingFiles];
      for (const a of added) files.push({ ...a, id: ++seq });
      return { pendingFiles: files, fileSeq: seq };
    });
  }, []);

  // Attachment picking (ported from the old filePicker change)
  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(e.target.files ?? [])];
    e.target.value = ""; // allow picking the same file again
    await addIncomingFiles(picked);
  };

  // ---- Clipboard image paste (Cmd+V screenshot detection) ----
  useEffect(() => {
    const comp = rootRef.current;
    if (!comp) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            const ext = file.type.split("/")[1] || "png";
            const namedFile = new File([file], `screenshot-${Date.now()}.${ext}`, { type: file.type });
            imgFiles.push(namedFile);
          }
        }
      }
      if (imgFiles.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        void addIncomingFiles(imgFiles);
      }
    };
    comp.addEventListener("paste", onPaste, true);
    return () => comp.removeEventListener("paste", onPaste, true);
  }, [addIncomingFiles]);

  const [dragOver, setDragOver] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = [...(e.dataTransfer.files ?? [])];
    if (files.length > 0) {
      void addIncomingFiles(files);
    }
  };

  // ---- Stop-button double-click guard reset (the old code reset disabled when
  // turn_end repainted) ----
  useEffect(() => {
    if (!canAbort) setStopPending(false);
  }, [canAbort]);

  // ---- Coordinated menu closing on outside click / window blur / omp:close-menus
  // (old window click/blur -> closeAllMenus) ----
  useEffect(() => {
    const close = () => {
      setOpenMenu(null);
      closeTypeahead();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    document.addEventListener("omp:close-menus", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("omp:close-menus", close);
    };
  }, [closeTypeahead]);

  // ---- Unmount cleanup of the @ candidate debounce timer ----
  useEffect(() => () => clearTimeout(mentionTimer.current ?? undefined), []);

  // ---- Bottom-bar graded collapse (ported from the old fitComposerBar; bar-N
  // classes are appended imperatively, React never overrides them since the
  // className prop stays constant) ----
  const fit = () => {
    const comp = rootRef.current;
    const cbar = cbarRef.current;
    if (!comp) return;
    comp.classList.remove("bar-1", "bar-2", "bar-3", "bar-4", "bar-5", "bar-6", "bar-7");
    let stage = 0;
    if (cbar) {
      // Needed width = sum of visible children's offsetWidth + gaps (not
      // scrollWidth: in WebKit an overflow:hidden flex container clamps
      // scrollWidth to clientWidth for flex:none children, unreliable)
      const gap = parseFloat(window.getComputedStyle(cbar).columnGap) || 6;
      const needWidth = () => {
        const vis = [...cbar.children].filter(
          (k) => !k.classList.contains("sp") && (k as HTMLElement).offsetWidth > 0, // children are all element nodes; offsetWidth is declared only on HTMLElement, narrowing suffices
        );
        return vis.reduce((a, k) => a + (k as HTMLElement).offsetWidth, 0) + gap * Math.max(0, vis.length - 1);
      };
      while (stage < BAR_STAGES && needWidth() > cbar.clientWidth) {
        stage++;
        comp.classList.add("bar-" + stage);
      }
    }
    if (stage !== barStageRef.current) {
      barStageRef.current = stage;
      // A stage change moves the buttons, anchors of open menus go stale; just close them
      if (comp.querySelector(".menu.open")) {
        setOpenMenu(null);
        closeTypeahead();
      }
    }
  };
  useLayoutEffect(fit);
  // Re-fit when the composer width changes due to window/split/zoom changes
  useEffect(() => {
    const comp = rootRef.current;
    if (!comp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(comp);
    return () => ro.disconnect();
  }, []);
  // Recompute the bottom-bar collapse after shell zoom (zoom does not trigger
  // ResizeObserver; shell.js notifies via omp:zoom)
  useEffect(() => {
    window.addEventListener("omp:zoom", fit);
    return () => window.removeEventListener("omp:zoom", fit);
  }, []);

  // ---- cbar button states ----
  // The pill must name the smart row too: with the gate on, "write" is not what
  // the next tool call will experience.
  const autoReviewOn = useAppStore((st) => st.hostSettings?.autoReviewEnabled === true);
  const modeMeta = (approvalMode === "write" && autoReviewOn) ? SMART_MODE : MODE_META[approvalMode] ?? MODE_META["always-ask"];
  const menuDisabled = !(hasSession || isCreatingNew) || isSubagent; // subagents cannot switch models


  // ---- Dictation auto-submit (stt.submitTrigger met): one-shot signal, the
  // effect closure always sees the freshest sendPrompt ----
  useEffect(() => {
    if (sttSubmitSignal === 0 || sttSubmitSignal === lastSubmitSeqRef.current) return;
    lastSubmitSeqRef.current = sttSubmitSignal;
    sendPrompt();
  }, [sttSubmitSignal]);

  // ---- External menu-open signal (shortcut Alt+M): a one-shot signal like
  // composerSetSignal ----
  useEffect(() => {
    const sig = menuSignal;
    if (!sig) return;
    useAppStore.setState({ menuSignal: null }); // silent write (same as before: the reset alone does not re-render)
    // The signal is written by keys.ts with the menu name ("model" — both the
    // ctrl+p preview and the shift+tab thinking cycle pop the merged menu)
    const menuName = sig.name as MenuName;
    if (!menuDisabled) setOpenMenu(menuName);
  });

  const modelName = isCreatingNew || !hasSession
    ? (modelShort(newSessionModel) || t("composer.modelFallback"))
    : modelShort(model) || t("composer.modelFallback");
  const thLv = (lv: string) => t(`composer.thinkingLevels.${lv}`, { defaultValue: lv });
  const thinkLabel = hasSession
    ? (thinking === "auto" && autoResolved ? `${thLv("auto")} · ${thLv(autoResolved)}` : thinking ? thLv(thinking) : t("composer.thinkFallback"))
    : newSessionThinking ? thLv(newSessionThinking) : t("composer.thinkFallback");
  // Merged pill: model name · thinking level (the ":level" suffix is stripped
  // by modelShort — the level now lives only in thinkLabel)
  const modelThinkLabel = `${modelName} · ${thinkLabel}`;
  // Narrow (phone) layout: the permission/model pills render in their own bar below
  // the input instead of the nowrap toolbar (see pillBar below).
  const narrow = useAppStore((st) => st.narrow);
  // Count selectors (Batch 1): numbers are Object.is-stable, so the pills re-render only
  // when a count changes; bgJobs is read inside the selector instead of subscribed
  const bgTasks = useAppStore((st) => {
    const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    return sess ? bgTaskCount(sess, st.bgJobs.get(bgJobsKey(sess.sessionId)) ?? null) : 0;
  });
  const bgSubs = useAppStore((st) => subagentCount(st.activePath ? st.openSessions.get(st.activePath) : undefined));

  // Menu button toggle: clicking the same button again closes; mutual exclusion
  // comes naturally from the single state; coordinate global menus before opening
  // (DOM class-state menus such as the settings page Sel close via closeAllMenus).
  // A manual open always shows the full menu: drop any ctrl+p preview state
  const toggleMenu = (name: MenuName) => (e: MouseEvent) => {
    e.stopPropagation(); // do not bubble to the window-level close listener
    if (openMenu !== name) closeAllMenus();
    useAppStore.setState({ cyclePreview: null, thinkMenuAuto: false });
    setOpenMenu(openMenu === name ? null : name);
  };

  // Background task / subagent button: expand and open the matching right-panel tab;
  // clicking again collapses the panel (ported from the old right.js binding). Both
  // targets are regular tabs — the add menu hides them (COMPOSER_ONLY_TABS only gates
  // the menu), but opening one from the pill must still register it in the tab head,
  // otherwise the panel expands with its old head and no tab to show for it.
  const toggleBgTab = (tab: string) => () => {
    if (!sessionId) return;
    const st = useAppStore.getState();
    // The expand invariants (todoCollapsed yield + selection cleanup) live in expandRightPanel
    if (!st.rightCollapsed && st.rightTab === tab) setBump({ rightCollapsed: true });
    else expandRightPanel(tab);
  };

  // Lexical init config: nodes registers ChipNode; editorState takes the
  // module-level draft snapshot (restored on mount slot switch)
  const initialConfig = useMemo(
    () => ({
      namespace: "omp-composer",
      onError(error: Error) {
        throw error; // fail fast: never silently swallow editor-internal exceptions
      },
      // GhostNode registers for drafts that still carry one (stripped on mount)
      nodes: [ChipNode, GhostNode],
      editorState: getDraftState(draftKey) ?? undefined,
    }),
    [draftKey],
  );

  const phText = t("composer.placeholder");

  // Permission / model selectors (the model pill carries the thinking level
  // after a "·"). Both placements render the same JSX: narrow (phone) moves
  // them out of the nowrap .cbar into the pill bar below the input, where the
  // full labels stay readable (the bar-N collapse only reaches .cbar); desktop
  // keeps them inline.
  const modePill = (
    <button
      className={"pill-btn" + (openMenu === "mode" ? " active" : "") + (modeMeta.yolo ? " yolo highlight-mode" : "")}
      id="modeBtn"
      title={t("composer.permissionMode")}
      ref={modeBtnRef}
      onClick={toggleMenu("mode")}
    >
      <Icon name={modeMeta.icon} id="modeIcon" />
      <span id="modeLabel">{modeMeta.label}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
    </button>
  );
  // Slash-command echo card: only for the session that produced it (a session switch hides it)
  const flash = commandFlash && commandFlash.sessionId === sessionId ? commandFlash : null;
  // The editor flips back in when the card unmounts (mirror of the card's own
  // entrance): a one-shot animation class, skipped when motion is off.
  const [returning, setReturning] = useState(false);
  const flashShownRef = useRef(false);
  useEffect(() => {
    const shown = Boolean(flash);
    const left = flashShownRef.current && !shown;
    flashShownRef.current = shown;
    if (!left || !motionEnabled()) return;
    setReturning(true);
    const timer = setTimeout(() => setReturning(false), 240);
    return () => clearTimeout(timer);
  }, [flash]);

  const modelThinkPills = (
    <button
      className={"pill-btn" + (openMenu === "model" ? " active" : "")}
      id="modelBtn"
      title={t("composer.switchModel")}
      ref={modelBtnRef}
      disabled={menuDisabled}
      onClick={toggleMenu("model")}
    >
      <span id="modelIcon">{model ? PROV_IC[model.split("/")[0]] || "✦" : "✦"}</span>
      <span id="modelLabel">{modelThinkLabel}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
    </button>
  );

  return (
    <>
      <div
        id="composer"
        className={
          (inWelcome ? "in-welcome " : "") +
          (isBashMode(text) ? "bash-mode " : "") +
          (dragOver ? "ring-1 ring-accent " : "") +
          (flash ? "flash-on " : "") +
          (returning ? "flash-return " : "")
        }
        ref={rootRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-hidden={blocking ? true : undefined}
        style={blocking ? { display: "none" } : undefined}
      >
        <div className="attach-fold">
          <AttachRow />
        </div>
        {CONTENT_EDITABLE_OK ? (
          <LexicalComposer initialConfig={initialConfig}>
            <div className="lex-wrap">
              <RichTextPlugin
                contentEditable={
                  <ContentEditable
                    id="input"
                    className="inp-ce"
                    aria-placeholder={phText}
                    placeholder={<span className="lex-ph">{phText}</span>}
                    aria-multiline={true}
                  />
                }
                placeholder={null}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </div>
            <HistoryPlugin />
            <ComposerPlugin draftKey={draftKey} handleRef={lexRef} onTextChange={onTextChange} sendPrompt={sendPrompt} typeaheadOpenRef={taOpenRef} />
            {/* Ghost inline completion (complete_text RPC); mounted after ComposerPlugin to share the same update stream */}
            <GhostTextPlugin typeaheadOpenRef={taOpenRef} />
            {/* ! bash-mode completion card (whole-line domain; shares the yield ref) */}
            <BashCompletePlugin typeaheadOpenRef={taOpenRef} composerRef={rootRef} />
            {/* key remount = the close-panel channel (closeTypeahead); triggerFn/onQueryChange have zero deps and stay stable, avoiding repeated listener re-registration */}
            <LexicalTypeaheadMenuPlugin
              key={closeTick}
              parent={rootRef.current ?? undefined}
              triggerFn={triggerFn}
              onQueryChange={onQueryChange}
              options={taOptions}
              onSelectOption={onSelectOption}
              menuRenderFn={menuRenderFn}
              onOpen={onTaOpen}
              onClose={onTaClose}
            />
          </LexicalComposer>
        ) : (
          /* Degraded placeholder for environments without contentEditable semantics
             (happy-dom smoke): Lexical is not initialized, editing operations all no-op */
          <div id="input" className="inp-ce" />
        )}
        <div className="cbar-fold">
          <div className="cbar" ref={cbarRef}>
          <button className="icon-btn plus-btn" id="plusBtn" title={t("composer.addContext")} onClick={() => pickerRef.current?.click()}>
            <Icon name="plus" />
          </button>
          {!narrow && modePill}
          {/* Plan mode: a small button right of the pill separated by |; on hover
              the icon flips to X meaning click to exit (in a session = host mode,
              new-session page = local create_session intent) */}
          {(planMode || (!hasSession && newSessionPlanMode)) && (
            <>
              <span className="cbar-sep" id="planSep">|</span>
              <button
                className="pill-btn plan-btn"
                id="planBtn"
                title={t("composer.planOnTitle")}
                onClick={() => {
                  // In a session the host owns the mode; on the new-session page the button clears the local intent
                  if (sessionId) send({ type: "set_plan_mode", sessionId, enabled: false });
                  else setBump({ newSessionPlanMode: false });
                }}
              >
                <span className="plan-ic">
                  <Icon name="plan" size={16} />
                  <Icon name="xmark" size={14} />
                </span>
                <span id="planLabel">{t("composer.planLabel")}</span>
              </button>
            </>
          )}
          {/* Computer use: screen-icon toggle between the plan button and the
              background-task buttons; lit (accent) = the per-session opt-in is
              on. In a session the host owns the state (set_computer_mode RPC);
              on the new-session page it flips the local create intent (same
              shape as plan mode), consumed by create_session. The host branches
              on the settings-page provider pick: default drives the builtin
              eval prelude (gated by the computer.enabled master switch), kimi
              mounts the kimi-cu MCP server into this session only — hence the
              button shows for either the master gate or the Kimi provider. */}
          {computerIconOn && (
            <button
              className={"pill-btn computer-btn" + ((computerMode || (!hasSession && newSessionComputerMode)) ? " on" : "")}
              id="computerBtn"
              title={(computerMode || (!hasSession && newSessionComputerMode)) ? t("composer.computerOnTitle") : t("composer.computerOffTitle")}
              onClick={() => {
                if (sessionId) send({ type: "set_computer_mode", sessionId, enabled: !computerMode });
                else setBump({ newSessionComputerMode: !newSessionComputerMode });
              }}
            >
              <Icon name="computer" size={15} />
            </button>
          )}
          {bgTasks > 0 && (
            <button
              className={"pill-btn bg-task-btn has-running" + (!rightCollapsed && rightTab === "bgcmd" ? " on" : "")}
              id="bgTaskBtn"
              title={t("composer.bgCommands")}
              disabled={!hasSession}
              onClick={toggleBgTab("bgcmd")}
            >
              <Icon name="termBox" size={15} />
              <span className="bg-task-num" id="bgTaskNum">{bgTasks}</span>
            </button>
          )}
          {bgSubs > 0 && (
            <button
              className={"pill-btn bg-task-btn has-running" + (!rightCollapsed && rightTab === "subagent" ? " on" : "")}
              id="bgSubagentBtn"
              title={t("composer.subagents")}
              disabled={!hasSession}
              onClick={toggleBgTab("subagent")}
            >
              <Icon name="agents" size={15} />
              <span className="bg-task-num" id="bgSubagentNum">{bgSubs}</span>
            </button>
          )}
          <span className="sp"></span>
          <CtxRing ringRef={setCtxRingEl} />
          <CtxCard anchor={ctxRingEl} />
          {!narrow && modelThinkPills}
          {/* Voice conversation: mic toggle left of send; lit = synthesis +
              dictation. Click toggles both switches; hold while lit =
              push-to-talk (the release click is swallowed). Not rendered on
              remote clients: no microphone without a secure context. */}
          {!REMOTE && (
          <button
            className={"pill-btn mic-btn" + (voiceMode ? " on" : "") + (voiceStt ? " rec" : "")}
            id="voiceBtn"
            title={
              voiceStt
                ? (voiceStt.state === "recording" ? t("composer.voiceListening") : t("composer.voiceTranscribing")) +
                  (voiceStt.message ? ` — ${voiceStt.message}` : "")
                : voiceMode
                  ? t("composer.voiceOnTitle")
                  : t("composer.voiceOffTitle")
            }
            onPointerDown={(e) => {
              if (!voiceMode || e.button !== 0) return;
              beginMicTalk();
            }}
            onPointerUp={endMicTalk}
            onPointerLeave={endMicTalk}
            onClick={() => {
              // A release after push-to-talk is not a mode toggle
              if (holdTalkRef.current) {
                holdTalkRef.current = false;
                return;
              }
              const next = !voiceMode;
              send({ type: "set_setting", key: "speech.enabled", value: next });
              send({ type: "set_setting", key: "stt.enabled", value: next });
            }}
          >
            <Icon name="mic" size={15} />
          </button>
          )}
          <button
            className={"send" + (canAbort ? " stop" : hasDraft ? " ready" : "") + (canAbort ? " stopping" : "")}
            id="sendBtn"
            disabled={stopping && stopPending}
            title={
              escArmed
                ? t("composer.sendEscAgain")
                : stopping
                  ? bashRunning && !streaming
                    ? t("composer.stopCommand")
                    : t("composer.stopGeneration")
                  : streaming
                    ? t("composer.sendQueued")
                    : t("composer.send")
            }
            onClick={() => {
              // Cancel form (stop generation / Esc warning window): abort
              // generation; send form: send/queue as usual
              if (canAbort) {
                if (stopPending) return;
                setStopPending(true); // double-click guard: reset on turn_end / bash_done
                // Abort is available only while streaming/running a command (s is
                // guaranteed then); the escArmed no-session path is unreachable,
                // the optional chain is defensive only
                send({ type: bashRunning && !streaming ? "bash_abort" : "abort_session", sessionId });
                return;
              }
              sendPrompt();
            }}
          >
            <Icon name={canAbort ? "stopSolid" : "arrowRight"} size={16} />
          </button>
          </div>
        </div>
        {/* Narrow only: the selector pills extend below the input card as their own bar, so
            permission / model / thinking render with full labels instead of collapsing to
            icons inside .cbar. Folds away with the toolbar in bash mode (CSS mirrors
            .cbar-fold's grid animation). */}
        {narrow && (
          <div className="pill-fold">
            <div className="pill-bar">
              {modePill}
              {modelThinkPills}
            </div>
          </div>
        )}
        {/* Permission mode (omp three values, large-row style) */}
        {openMenu === "mode" && <ModeMenu btnRef={modeBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        {/* Merged model + thinking menu (delivered after the host filters
            enabledModels; the second-level overlay is a direct child of #composer) */}
        {openMenu === "model" && <ModelMenu btnRef={modelBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        <input type="file" id="filePicker" multiple hidden ref={pickerRef} onChange={onPick} />
        {/* A consumed slash command echoes here: the whole composer card (editor +
            toolbar) is replaced for ~1s by this page-turning card. Siblings are
            hidden, not unmounted, so the draft and caret survive; keyed on seq so
            a second command replays the flip. */}
        {flash && (
          <div className={"cmdf" + (flash.phase === "out" ? " is-out" : "")} key={flash.seq}>
            <div className="cmdf-c">{flash.command || flash.text}</div>
            {flash.command && flash.text && <div className="cmdf-o">{flash.text}</div>}
          </div>
        )}
      </div>
    </>
  );
}

// Context ring (ported from the ctxRing section of the old renderComposerBar):
// filled clockwise from the top; empty ring without data; the creating-new state
// also shows an empty ring. The hover context detail card lives in
// chat/CtxCard.jsx (ringRef is only an anchor, the inner svg is untouched)
function CtxRing({ ringRef }: { ringRef: Ref<HTMLSpanElement> }) {
  const isCreatingNew = useAppStore((st) => st.isCreatingNew);
  // Cache-warming probe count for this session (pushed by the host on every
  // keepalive reportState; only sessions with the extension injected report).
  // Hidden by the ctxRingProbeCount pref (default on).
  const kaAll = useAppStore((st) => st.keepaliveStatus);
  const showCount = useAppStore((st) => st.uiPrefs.ctxRingProbeCount) !== false;
  // Field-level subscriptions (Batch 1): ctx is replaced wholesale by the context
  // frame (new object per write), so a reference selector stays correct
  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const ctx = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.ctx : undefined));
  const ka = sessionId ? kaAll[sessionId] : undefined;
  const probes = showCount && ka && ka.enabled && ka.probes > 0 ? (ka.probes > 99 ? "99" : String(ka.probes)) : null;
  if (!sessionId && !isCreatingNew) return null;
  const p = ctx ? Math.min(1, ctx.percent / 100) : 0;
  const cls = "ctx-ring" + (ctx ? (ctx.percent >= 85 ? " hot" : ctx.percent >= 60 ? " warm" : "") : "");
  return (
    <span className={cls} id="ctxRing" title="" ref={ringRef}>
      <svg viewBox="0 0 16 16" width="16" height="16">
        <circle className="track" cx="8" cy="8" r="7" />
        <circle
          className="fill"
          id="ctxRingFill"
          cx="8"
          cy="8"
          r="7"
          transform="rotate(-90 8 8)"
          style={{ strokeDashoffset: String(RING_C * (1 - p)) }}
        />
        {probes ? (
          <text x="8" y="8" textAnchor="middle" dominantBaseline="central" fontSize="8" fill="currentColor">
            {probes}
          </text>
        ) : null}
      </svg>
    </span>
  );
}

// Model display name: strip the base ":level" suffix (the level renders in the
// merged pill via thinkLabel), then look up modelNames; without an entry take
// the id tail (same as the old renderComposerBar)
function modelShort(id: string | null | undefined) {
  if (!id) return "";
  const cut = id.lastIndexOf(":");
  const base = cut > 0 ? id.slice(0, cut) : id;
  return useAppStore.getState().modelNames.get(base) ?? base.split("/").pop() ?? "";
}
