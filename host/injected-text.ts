// Host-injected prompt text (pasted file bodies, referenced-session turns) is model
// input, not something the user typed — but it rides in the same string the base and
// the host parse for user tokens. This module owns the one guard that keeps those
// tokens inert without rewriting code the model must read byte-for-byte.
import { resolveReadPath } from "./bootstrap.ts";

const MENTION_RE = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const MENTION_BOUNDARY = /[\s([{<"'`]/;
const MENTION_EDGE = /^[`"'([{<]+|[)\]}>.,;:!?"'`]+$/g;

/** Escape the tokens in injected text that would otherwise be acted on as if the user
 *  had typed them: `@path` (the base auto-reads every mention in the prompt text,
 *  file-mentions.ts extractFileMentions) and `/skill:<name>` (prompt.ts dispatches it
 *  from the whole text). Only mentions that resolve to a real path are escaped —
 *  `@Component` or `@media` in pasted code must reach the model byte-for-byte. `\` sits
 *  outside both grammars' boundary sets, so `\@` and `\/skill:` stay prose. */
export async function escapeInjectedTokens(text: string, cwd: string): Promise<string> {
  const hits: Array<{ start: number; token: string }> = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > 0 && !MENTION_BOUNDARY.test(text[start - 1])) continue;
    const token = (m[1] ?? m[2] ?? m[3] ?? "").replace(MENTION_EDGE, "");
    if (token) hits.push({ start, token });
  }
  const resolvable = await Promise.all(
    hits.map(async (hit) => {
      try {
        await Bun.file(resolveReadPath(hit.token, cwd)).stat();
        return true;
      } catch {
        return false;
      }
    }),
  );
  let out = "";
  let last = 0;
  hits.forEach((hit, i) => {
    if (!resolvable[i]) return;
    out += `${text.slice(last, hit.start)}\\`;
    last = hit.start;
  });
  return (out + text.slice(last)).replace(/\/skill:/g, "\\/skill:");
}
