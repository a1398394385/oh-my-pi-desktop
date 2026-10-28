// Review comments on a diff: the payload handed to an agent, in the same
// Markdown shape MyGit's commentsMarkdown emits (one section per comment with
// its file:lines heading, a fenced code block of the commented lines, then the
// body) so prompts written here read the same as prompts copied there.
export interface ReviewComment {
  path: string;
  /** Revision the comment is on; empty/undefined = working-tree changes. */
  rev?: string;
  /** Comment anchored on the removed side of the diff. */
  oldSide?: boolean;
  /** Lines it covers, as "12" or "12-14", from 1. */
  lines: string;
  /** Those lines, as the diff shows them. */
  code: string[];
  body: string;
}

/** Fence language: the file's extension without its dot (Go's path.Ext, trimmed). */
function fenceLang(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1);
}

export function commentsMarkdown(list: readonly ReviewComment[]): string {
  let out = "# Address these Review Comments\n";
  list.forEach((c, i) => {
    out += `\n## ${i + 1}. ${c.path}:${c.lines}`;
    // A range rev ("a..b") names no single commit, so it is left out rather than truncated.
    if (c.rev && !c.rev.includes("..")) out += ` (commit ${c.rev.slice(0, 8)})`;
    if (c.oldSide) out += " (removed lines)";
    out += `\n\n\`\`\`${fenceLang(c.path)}\n${c.code.join("\n")}\n\`\`\`\n\n${c.body}\n`;
  });
  return out;
}
