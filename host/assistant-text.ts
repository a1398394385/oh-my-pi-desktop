// Extension assistant-text renderers (extensionRenderers.assistantText): display-only markdown
// transforms. Extensions run in the host process, so the transform happens here and the UI only
// ever receives the markdown they produced — the session, exports and model context keep the
// original text (base contract of AssistantTextRenderer).
import type { AssistantTextRenderer } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { safeStderr } from "./stderr.ts";
import { entryBus, stampEvent, type PoolEntry } from "./state.ts";

type RenderContext = Parameters<AssistantTextRenderer>[0];

/** The reply snapshot renderers draw on (an AssistantMessage; narrowed here to dodge a direct
 *  pi-ai type import across the host boundary). */
export type AssistantMessageLike = RenderContext["message"];

/** Apply the renderers in load order; each sees the previous one's output (base contract). */
export function renderAssistantText(
  renderers: readonly AssistantTextRenderer[],
  message: RenderContext["message"] | undefined,
  contentIndex: number,
  text: string,
  streaming: boolean,
): string {
  // Renderers need the reply they are drawing; without it nothing can be transformed.
  if (!message) return text;
  // The base hands renderers a deep copy so an edit cannot reach the stored reply; the host only
  // ever passes the immutable streaming snapshot, which is safe to share.
  const context = { message, contentIndex, text, streaming };
  let out = text;
  for (const render of renderers) {
    try {
      const next = render({ ...context, text: out });
      if (typeof next === "string") out = next;
    } catch (error) {
      // A broken renderer must not kill the stream; report it and keep the text as drawn so far
      safeStderr(`[extensions] assistant text renderer failed: ${String((error as Error)?.message ?? error)}\n`);
    }
  }
  return out;
}

/**
 * ctx.ui.rerenderMessage: an extension re-draws one reply block after its own state changed.
 * Rows are addressed by reply timestamp + block index, the pair host/translate.ts stamps on them.
 */
export function rerenderAssistantMessage(entry: PoolEntry, sessionId: string, timestamp: number): void {
  const renderers = entry.session.extensionRunner?.getAssistantTextRenderers() ?? [];
  const message = entry.session.messages.find(
    (m): m is AssistantMessageLike => m.role === "assistant" && m.timestamp === timestamp,
  );
  if (renderers.length === 0 || !message) return;
  const bus = entryBus(entry);
  ((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).forEach((block, index) => {
    if (block?.type !== "text" || typeof block.text !== "string") return;
    const item = entry.transcript.find((t) => t.role === "assistant" && t.ts === timestamp && t.block === index);
    if (!item) return;
    item.text = renderAssistantText(renderers, message, index, block.text, false);
    bus.send(JSON.stringify(stampEvent({ type: "event", sessionId, kind: "assistant_rerender", ts: timestamp, block: index, text: item.text })));
  });
}
