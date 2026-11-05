// `<inject>` parsing for /btw answers, kept out of BtwPage.tsx so it stays importable
// without the DOM (the module has no React/store imports).
const INJECT_OPEN = "<inject>";
const INJECT_CLOSE = "</inject>";

/** Split an answer around its first closed `<inject>` block (the base prompt asks for one).
 *  Extra blocks stay in the prose; a blank block is not worth a send button. */
export function splitInject(answer: string): { before: string; inject: string; after: string } | undefined {
  const open = answer.indexOf(INJECT_OPEN);
  if (open === -1) return undefined;
  const close = answer.indexOf(INJECT_CLOSE, open + INJECT_OPEN.length);
  if (close === -1) return undefined;
  const inject = answer.slice(open + INJECT_OPEN.length, close).trim();
  if (!inject) return undefined;
  return { before: answer.slice(0, open), inject, after: answer.slice(close + INJECT_CLOSE.length) };
}
