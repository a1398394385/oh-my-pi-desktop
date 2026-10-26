// Pre-parse fix for a `**…**` span whose closing `**` is followed by a non-space character
// (typically CJK punctuation such as （): micromark's GFM autolink swallows the closing `**`
// into the URL path — trailing punctuation is only trimmed before whitespace/EOF — which
// breaks emphasis pairing and renders the `**` literally in the chat surface. Only a URL that
// ends the span can be the one swallowing the `**`; rewriting it as an angle-bracket autolink
// gives it a hard boundary, so the `**` stays a text-level delimiter and the bold parses. Link
// text is unchanged; only the boundary moves. Fenced code lines and inline code spans are left
// verbatim.
// shortcut: a trailing URL keeps any CJK punctuation glued to it inside <>, rare enough that
// the bold rescue matters more than the trailing character; split it here if it ever bites.
const STRONG_SWALLOWED_RE = /\*\*((?:[^*\n]|\*(?!\*))+?)\*\*(?=[^\s<(])/g;
const TRAILING_URL_RE = /(https?:\/\/[^\s<>`]+)$/;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`+)(?:[\s\S]*?[^`])?\1(?!`)/g;

function fixStrongAutolinkLine(line: string): string {
  const spans: string[] = [];
  const masked = line.replace(INLINE_CODE_RE, (span) => `\u0000${spans.push(span) - 1}\u0000`);
  return masked
    .replace(STRONG_SWALLOWED_RE, (_, inner: string) => `**${inner.replace(TRAILING_URL_RE, "<$1>")}**`)
    .replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

export function fixStrongAutolink(text: string): string {
  let fence = ""; // open fence sequence; empty when outside fenced code
  return text
    .split("\n")
    .map((line) => {
      const fenceMatch = line.match(FENCE_LINE_RE);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
          fence = "";
        }
        return line; // inside fenced code: verbatim
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        return line; // fence opener line itself: verbatim
      }
      return fixStrongAutolinkLine(line);
    })
    .join("\n");
}
