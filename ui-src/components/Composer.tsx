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
import { updateSession } from "../store/session";
import type { PromptAttachment, SlashCommand } from "../types/frames";
import { closeAllMenus } from "../shell";
import Icon from "../Icon";
import AttachRow from "./composer/AttachRow";
import ModeMenu, { MODE_META } from "./composer/ModeMenu";
import ModelMenu from "./composer/ModelMenu";
import ThinkMenu from "./composer/ThinkMenu";
import PaletteMenu from "./composer/PaletteMenu";
import type { PaletteItem, CommandItem } from "./composer/PaletteMenu";
import { detectTrigger, isBashMode, insertFile, insertCommand } from "./composer/trigger";
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
  CONTENT_EDITABLE_OK,
} from "./composer/lexical/draft";
import ComposerPlugin from "./composer/lexical/ComposerPlugin";
import type { ComposerHandle } from "./composer/lexical/ComposerPlugin";
import { setTtsDuck } from "../lib/speechOut";

// Slash command candidate filter: empty query returns all, grouped and sorted by
// source (builtin->skill->extension->custom->others); non-empty first matches
// name/aliases by prefix, then by includes, then falls back to source order; cap 50
const SRC_RANK: Record<string, number> = { builtin: 0, skill: 1, extension: 2, custom: 3, file: 4 };
function filterCommands(list: CommandItem[] | null | undefined, query: string): CommandItem[] {
  if (!Array.isArray(list) || !list.length) return [];
  const rank = (c: CommandItem) => SRC_RANK[c.source ?? ""] ?? 9;
  const q = (query || "").toLowerCase();
  if (!q) return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 50);
  const pre: CommandItem[] = [];
  const incl: CommandItem[] = [];
  for (const c of list) {
    const names = [c.name, ...(c.aliases || [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) pre.push(c);
    else if (names.some((n) => n.includes(q))) incl.push(c);
  }
  const byRank = (a: CommandItem, b: CommandItem) => rank(a) - rank(b) || a.name.localeCompare(b.name);
  return [...pre.sort(byRank), ...incl.sort(byRank)].slice(0, 50);
}
// $ skill candidate filter: the source==="skill" entries of the same commands
// list; matching uses the bare name (strip the "skill:" prefix the host reports)
function filterSkills(list: CommandItem[] | null | undefined, query: string): CommandItem[] {
  if (!Array.isArray(list) || !list.length) return [];
  const bare = (c: CommandItem) => c.name.replace(/^skill:/, "");
  const skills = list.filter((c) => c.source === "skill");
  const byBare = (a: CommandItem, b: CommandItem) => bare(a).localeCompare(bare(b));
  const q = (query || "").toLowerCase();
  if (!q) return skills.sort(byBare).slice(0, 50);
  const pre: CommandItem[] = [];
  const incl: CommandItem[] = [];
  for (const c of skills) {
    const n = bare(c).toLowerCase();
    if (n.startsWith(q)) pre.push(c);
    else if (n.includes(q)) incl.push(c);
  }
  return [...pre.sort(byBare), ...incl.sort(byBare)].slice(0, 50);
}
// Subcommand candidate filter for commandArgs triggers: prefix match,
// lowercase (aligned with the base TUI's buildArgumentCompletions); entries
// reuse the CommandItem shape (name/description/hint = usage)
function filterSubcommands(subs: SlashCommand["subcommands"] | undefined, query: string): CommandItem[] {
  if (!Array.isArray(subs) || !subs.length) return [];
  const q = (query || "").toLowerCase();
  return subs.filter((s) => s.name.toLowerCase().startsWith(q)).map((s) => ({ name: s.name, description: s.description, hint: s.usage }));
}


// Size cap for attachments to send: images go through ImageContent (base64),
// text-like files are inlined into the prompt
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

// Provider sigils (copied from ui/settings/index.js PROV_IC; that module has
// settings-page binding side effects at top level, so importing it is not viable)
const PROV_IC: Record<string, string> = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };

// Context ring circumference: 2*pi*7 (matches the CSS dasharray)
const RING_C = 43.98;

// Max stage of the bottom-bar graded collapse (permission mode/think/model ->
// icon only, hide subagents, hide background tasks)
const BAR_STAGES = 5;

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

// Structural subset of a session tool row (bgTaskCount reads only these fields;
// see the store for the full shape)
type BgToolItem = {
  role?: string;
  name?: string;
  text?: string;
  args?: { op?: string; name?: string; application?: string };
  running?: boolean;
};

// Running background command count (ported from the runningCount part of the old
// right.js getBgTasksForSession: only iterates top-level s.items -- tools wrapped
// in loop groups no longer count; hub start counts in, stop/cancel offsets the
// same-named process)
function bgTaskCount(s: { items?: BgToolItem[] } | null | undefined) {
  if (!s) return 0;
  let n = 0;
  const live = new Set<string>();
  for (const it of s.items ?? []) {
    if (it.role !== "tool") continue;
    const name = it.name || it.text || "";
    if (name === "hub") {
      const args = it.args || {};
      const op = args.op || "cmd";
      const proc = args.name || args.application || "";
      // Only count background processes by pairing start/stop/cancel. Do not fall
      // back to it.running: that means "hub tool executing" (between the tool and
      // tool_update frames); list/status hit it equally, it is not liveness
      if (op === "start") {
        n++;
        if (proc) live.add(proc);
      } else if ((op === "stop" || op === "cancel") && proc && live.has(proc)) {
        n--;
        live.delete(proc);
      }
    } else if (it.running && (name === "bash" || name === "shell" || name === "eval")) {
      n++;
    }
  }
  return Math.max(0, n);
}

// Running subagent count (ported from the old right.js getRunningSubagentCount)
function subagentCount(s: { subagents?: Map<string, { streaming?: boolean; status?: string }> } | null | undefined) {
  if (!s?.subagents) return 0;
  return [...s.subagents.values()].filter((x) => x.streaming || x.status === "started").length;
}

type MenuName = "mode" | "model" | "think";

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
  // Active session (updateSession frame handling swaps the session/Map reference,
  // the selector senses it by reference)
  const activePath = useAppStore((st) => st.activePath);
  const draftKey = inWelcome ? "welcome" : (activePath || "welcome");
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const pendingFiles = useAppStore((st) => st.pendingFiles);
  const escArmedUntil = useAppStore((st) => st.escArmedUntil);
  const composerSetSignal = useAppStore((st) => st.composerSetSignal);
  const menuSignal = useAppStore((st) => st.menuSignal);
  const isCreatingNew = useAppStore((st) => st.isCreatingNew);
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const newSessionThinking = useAppStore((st) => st.newSessionThinking);
  const newSessionPlanMode = useAppStore((st) => st.newSessionPlanMode);
  const newSessionComputerMode = useAppStore((st) => st.newSessionComputerMode);
  const computerGateOn = useAppStore((st) => st.hostSettings?.computerEnabled === true);
  // Voice conversation mode = synthesis + dictation switches both on; the mic
  // button toggles them together and lights while they hold
  const voiceMode = useAppStore(
    (st) => st.hostSettings?.values?.["speech.enabled"] === true && st.hostSettings?.values?.["stt.enabled"] === true,
  );
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
  const thinkBtnRef = useRef<HTMLButtonElement>(null);
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null); // "mode" | "model" | "think" | null (mutually exclusive)
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
      send({ type: "stt_start", sessionId: s?.sessionId ?? "", anchor: getDraftText(draftKey) });
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
  const bashRunning = !!s?.items?.some((x: { role?: string; running?: boolean }) => x.role === "bash" && x.running);
  const stopping = (!!s?.streaming || bashRunning) && !hasDraft;
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

  // ---- Send path (ported from the old sendPrompt) ----
  // Resolved here because sendPrompt's local `t` (draft text) shadows the
  // translation function inside its scope.
  const needSessionMsg = t("composer.needSession");
  const subagentNoSlashMsg = t("chat.subagentSlashNotSupported");
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
    // raw: untrimmed editor text (bash-mode detection requires ! as the first
    // character, leading whitespace keeps it off); t: trimmed for send payloads
    const raw = getDraftText(draftKey);
    const t = raw.trim();
    const files = buildAttachPayload();
    const ws = useAppStore.getState().ws;
    if ((!t && files.length === 0) || !ws || ws.readyState !== 1) return;

    // Subagent sessions do not support slash or terminal commands
    if (s?.isSubagent && (t.startsWith("/") || isBashMode(raw))) {
      toast(subagentNoSlashMsg);
      return;
    }

    // bash mode (! as the first character, !! = result kept out of model
    // context): executed locally, no user bubble; the row is created by the
    // bash_start frame (aligned with the TUI input-controller send routing)
    if (isBashMode(raw)) {
      const excludeFromContext = raw.startsWith("!!");
      const command = excludeFromContext ? raw.slice(2).trim() : raw.slice(1).trim();
      if (!command) return; // `!` / `!!` with empty command: no action (same as TUI)
      // Welcome page (no session yet): auto-create one like a first message,
      // then execute after the session_created receipt
      if (isCreatingNew || !s) {
        useAppStore.setState({ pendingNewBash: { command, excludeFromContext } });
        clearDraft();
        send({
          type: "create_session",
          cwd: useAppStore.getState().newSessionProject || undefined,
          model: newSessionModel || undefined,
          thinking: newSessionThinking || undefined,
          planMode: newSessionPlanMode || undefined,
          computerMode: newSessionComputerMode || undefined,
        });
        useAppStore.setState({ pendingCreate: true });
        return;
      }
      clearDraft();
      send({ type: "bash_exec", sessionId: s.sessionId, command, excludeFromContext });
      return;
    }

    // Creating-new state: store the draft in pendingNewPrompt; the store sends it
    // after the session_created receipt
    if (isCreatingNew || !s) {
      useAppStore.setState({ pendingNewPrompt: { text: t, files } });
      clearDraft();
      send({
        type: "create_session",
        cwd: useAppStore.getState().newSessionProject || undefined,
        model: newSessionModel || undefined,
        thinking: newSessionThinking || undefined,
        planMode: newSessionPlanMode || undefined,
        computerMode: newSessionComputerMode || undefined,
      });
      useAppStore.setState({ pendingCreate: true });
      return;
    }
    // Extract image payloads for immediate frontend bubble rendering
    const imgPayload: Array<{ type: "image"; data: string; mimeType: string }> = files
      .filter((f) => f.kind === "image" && typeof f.data === "string")
      .map((f) => ({ type: "image", data: f.data as string, mimeType: f.mime || "image/png" }));


    // Sending while streaming = enqueue as followUp (auto-consumed when the
    // current loop finishes); Ctrl+↵ is steer -- immediate injection (after the
    // current tool batch), the bubble is pinned at the bottom of the message
    // flow, and the split happens at consumption time (steer_consumed)
    // updateSession swaps the session/Map reference: both selector-subscribed
    // components (this component / QueueCard) and the old useStore components see it
    if (s.streaming) {
      updateSession(s.sessionId, (next) => {
        if (steer) {
          next.steering = next.steering ?? [];
          next.steering.push({ text: t });
          next.items.push({
            role: "user",
            text: t,
            pending: "steer",
            ...(imgPayload.length > 0 ? { images: imgPayload } : {}),
          });
        } else {
          next.queued = next.queued ?? [];
          next.queued.push({ text: t });
        }
      });
    } else {
      updateSession(s.sessionId, (next) => {
        next.items.push({
          role: "user",
          text: t,
          ...(imgPayload.length > 0 ? { images: imgPayload } : {}),
        });
        // Set the running state locally right away: the timer starts at send time
        // and the send button flips to stop (the host turn_start keeps the origin
        // without resetting it once it arrives)
        next.streaming = true;
        next.turnStartAt = Date.now();
      });
    }
    clearDraft();
    ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text: t, files, ...(steer ? { steer: true } : {}) }));
    // Sidebar time = user-message time: stamp the list row now (steer/queued sends count
    // too); the runEnd session_list refresh later carries the authoritative end time.
    // Match by path (activePath = this session's file path): the pool sessionId is a
    // per-open UUID and never equals the list row's disk session id
    useAppStore.getState().bumpSessionActivity(activePath!);
    // Pin-to-bottom following is handled by Chat's scroll effect
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
    comp.classList.remove("bar-1", "bar-2", "bar-3", "bar-4", "bar-5");
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
  const modeMeta = MODE_META[approvalMode] ?? MODE_META["always-ask"];
  const menuDisabled = !(s || isCreatingNew) || Boolean(s?.isSubagent); // subagents cannot switch models


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
    // The signal is written by keys.ts with fixed menu names ("model"/"think"/"mode");
    // the assertion narrows to this component's menu name union
    const menuName = sig.name as MenuName;
    if (!menuDisabled) setOpenMenu(menuName);
  });

  const modelName = isCreatingNew || !s
    ? (newSessionModel ? (modelShort(newSessionModel) || t("composer.modelFallback")) : t("composer.modelFallback"))
    : modelShort(s.model) || t("composer.modelFallback");
  const thinkLabel = s
    ? (s.thinking === "auto" && s.autoResolved ? `auto·${s.autoResolved}` : s.thinking || t("composer.thinkFallback"))
    : newSessionThinking || t("composer.thinkFallback");
  const bgTasks = bgTaskCount(s);
  const bgSubs = subagentCount(s);

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

  // Background task / subagent button: expand and switch the right panel to the
  // matching tab; clicking again collapses the right panel (ported from the old
  // right.js binding)
  const toggleBgTab = (tab: string) => () => {
    if (!s) return;
    const st = useAppStore.getState();
    if (!st.rightCollapsed && st.rightTab === tab) {
      setBump({ rightCollapsed: true });
    } else {
      setBump({ rightTab: tab, selectedFile: null, selectedSubagent: null, rightCollapsed: false, todoCollapsed: true }); // expanding the right panel yields to collapse the process card (same as parts.jsx)
    }
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

  return (
    <>
      <div
        id="composer"
        className={(inWelcome ? "in-welcome " : "") + (isBashMode(text) ? "bash-mode " : "") + (dragOver ? "ring-1 ring-accent " : "")}
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
          {/* Plan mode: a small button right of the pill separated by |; on hover
              the icon flips to X meaning click to exit (in a session = host mode,
              new-session page = local create_session intent) */}
          {(s?.planMode || (!s && newSessionPlanMode)) && (
            <>
              <span className="cbar-sep" id="planSep">|</span>
              <button
                className="pill-btn plan-btn"
                id="planBtn"
                title={t("composer.planOnTitle")}
                onClick={() => {
                  // In a session the host owns the mode; on the new-session page the button clears the local intent
                  if (s) send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: false });
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
              shape as plan mode), consumed by create_session. The whole button
              only exists while the settings-page master gate is open — closing
              it also force-kills every live opt-in (host sweep) and removes
              /computer from the palette, so nothing dangles. */}
          {computerGateOn && (
            <button
              className={"pill-btn computer-btn" + ((s?.computerMode || (!s && newSessionComputerMode)) ? " on" : "")}
              id="computerBtn"
              title={(s?.computerMode || (!s && newSessionComputerMode)) ? t("composer.computerOnTitle") : t("composer.computerOffTitle")}
              onClick={() => {
                if (s) send({ type: "set_computer_mode", sessionId: s.sessionId, enabled: !s.computerMode });
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
              disabled={!s}
              onClick={toggleBgTab("bgcmd")}
            >
              <Icon name="termBox" size={15} />
              <span className="bg-task-num" id="bgTaskNum">{s ? bgTasks : 0}</span>
            </button>
          )}
          {bgSubs > 0 && (
            <button
              className={"pill-btn bg-task-btn has-running" + (!rightCollapsed && rightTab === "subagent" ? " on" : "")}
              id="bgSubagentBtn"
              title={t("composer.subagents")}
              disabled={!s}
              onClick={toggleBgTab("subagent")}
            >
              <Icon name="agents" size={15} />
              <span className="bg-task-num" id="bgSubagentNum">{s ? bgSubs : 0}</span>
            </button>
          )}
          <span className="sp"></span>
          <CtxRing s={s} ringRef={setCtxRingEl} />
          <CtxCard anchor={ctxRingEl} />
          <button
            className={"pill-btn" + (openMenu === "model" ? " active" : "")}
            id="modelBtn"
            title={t("composer.switchModel")}
            ref={modelBtnRef}
            disabled={menuDisabled}
            onClick={toggleMenu("model")}
          >
            <span id="modelIcon">{s?.model ? PROV_IC[s.model.split("/")[0]] || "✦" : "✦"}</span>
            <span id="modelLabel">{modelName}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          <button
            className={"pill-btn" + (openMenu === "think" ? " active" : "")}
            id="thinkBtn"
            title={t("composer.thinkLevel")}
            ref={thinkBtnRef}
            disabled={menuDisabled}
            onClick={toggleMenu("think")}
          >
            <Icon name="think" size={16} />
            <span id="thinkLabel">{thinkLabel}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          {/* Voice conversation: mic toggle left of send; lit = synthesis +
              dictation. Click toggles both switches; hold while lit =
              push-to-talk (the release click is swallowed). */}
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
          <button
            className={"send" + (canAbort ? " stop" : hasDraft ? " ready" : "") + (canAbort ? " stopping" : "")}
            id="sendBtn"
            disabled={stopping && stopPending}
            title={
              escArmed
                ? t("composer.sendEscAgain")
                : stopping
                  ? bashRunning && !s?.streaming
                    ? t("composer.stopCommand")
                    : t("composer.stopGeneration")
                  : s?.streaming
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
                send({ type: bashRunning && !s?.streaming ? "bash_abort" : "abort_session", sessionId: s?.sessionId });
                return;
              }
              sendPrompt();
            }}
          >
            <Icon name={canAbort ? "stopSolid" : "arrowRight"} size={16} />
          </button>
          </div>
        </div>
        {/* Permission mode (omp three values, large-row style) */}
        {openMenu === "mode" && <ModeMenu btnRef={modeBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        {/* Model (delivered after the host filters enabledModels, grouped by
            provider; the second-level overlay is a direct child of #composer) */}
        {openMenu === "model" && <ModelMenu btnRef={modelBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        <input type="file" id="filePicker" multiple hidden ref={pickerRef} onChange={onPick} />
        {/* Think level (only lists tiers supported by the current model) */}
        {openMenu === "think" && <ThinkMenu btnRef={thinkBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
      </div>
    </>
  );
}

// Context ring (ported from the ctxRing section of the old renderComposerBar):
// filled clockwise from the top; empty ring without data; the creating-new state
// also shows an empty ring. The hover context detail card lives in
// chat/CtxCard.jsx (ringRef is only an anchor, the inner svg is untouched)
function CtxRing({ s, ringRef }: { s: { ctx?: { percent: number }; sessionId?: string } | null | undefined; ringRef: Ref<HTMLSpanElement> }) {
  const isCreatingNew = useAppStore((st) => st.isCreatingNew);
  // Cache-warming probe count for this session (pushed by the host on every
  // keepalive reportState; only sessions with the extension injected report).
  // Hidden by the ctxRingProbeCount pref (default on).
  const ka = useAppStore((st) => st.keepaliveStatus);
  const showCount = useAppStore((st) => st.uiPrefs.ctxRingProbeCount) !== false;
  const probes = showCount && ka && s?.sessionId && ka.sessionId === s.sessionId && ka.enabled && ka.probes > 0 ? (ka.probes > 99 ? "99" : String(ka.probes)) : null;
  if (!s && !isCreatingNew) return null;
  const p = s?.ctx ? Math.min(1, s.ctx.percent / 100) : 0;
  const cls = "ctx-ring" + (s?.ctx ? (s.ctx.percent >= 85 ? " hot" : s.ctx.percent >= 60 ? " warm" : "") : "");
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

// Model display name: look up modelNames; without an entry take the id tail
// (same as the old renderComposerBar)
function modelShort(id: string | null | undefined) {
  if (!id) return "";
  return useAppStore.getState().modelNames.get(id) ?? id.split("/").pop();
}
