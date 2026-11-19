// A referenced session's turns are model input, not a user turn: the base auto-reads
// every `@mention` in the prompt text and the host dispatches `/skill:` from the whole
// text, so such a token inside quoted history must not resolve (it would read the wrong
// files or run a skill nobody invoked). Tokens that resolve to nothing stay byte-exact.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/session-reference-mention.test.ts
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatSessionReference } from "../host/session-context.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-ref-"));
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

test("escapes only the quoted tokens that would actually be acted on", async () => {
  await fs.writeFile(path.join(dir, "real.ts"), "x", "utf8");
  const file = path.join(dir, "ref.jsonl");
  const row = (id: string, parentId: string | null, role: string, text: string) =>
    JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: "2026-11-18T00:00:00.000Z",
      message: { role, content: [{ type: "text", text }] },
    });
  await fs.writeFile(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "ref-test", timestamp: "2026-11-18T00:00:00.000Z", cwd: dir }),
      row("a", null, "user", `@${dir} 与 @real.ts 与 @missing.ts 与 @Component 与 /skill:demo`),
      row("b", "a", "assistant", "看 @also-missing.ts"),
    ].join("\n") + "\n",
    "utf8",
  );
  const block = await formatSessionReference(file, dir);
  // Resolvable: escaped, so neither the base nor the host acts on them.
  expect(block).toContain(`\\@${dir}`);
  expect(block).toContain("\\@real.ts");
  expect(block).toContain("\\/skill:demo");
  // Unresolvable: pasted code keeps its bytes.
  expect(block).toContain("@missing.ts");
  expect(block).toContain("@also-missing.ts");
  expect(block).toContain("@Component");
});
