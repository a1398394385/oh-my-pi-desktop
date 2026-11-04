// @file mentions render as attachment chips on the user bubble: the base's fileMention
// entry (written right after the prompt it auto-read) folds its paths onto that user row
// instead of emitting a standalone read-back row.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/translate-history-attachments.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { entriesToTranscript } from "../host/translate-history.ts";

const userEntry = (id: string, parentId: string | null, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", timestamp: 0, content: [{ type: "text", text }] },
});
const fileMention = (id: string, parentId: string | null, paths: string[]) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "fileMention", timestamp: 0, files: paths.map((path) => ({ path, content: "x" })) },
});

describe("entriesToTranscript @mention folding", () => {
  test("paths land on the user row that issued the prompt", () => {
    const out = entriesToTranscript([userEntry("u1", null, "看下 @/a.md"), fileMention("m1", "u1", ["/a.md"])]);
    const users = out.filter((item) => item.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].attachments).toEqual(["/a.md"]);
  });

  test("no standalone mention row is emitted", () => {
    const out = entriesToTranscript([userEntry("u1", null, "hi"), fileMention("m1", "u1", ["/a.md", "/b.png"])]);
    expect(out.some((item) => (item.role as string) === "mention")).toBe(false);
  });

  test("secondary prompts fold their own mentions, not the previous turn's", () => {
    const out = entriesToTranscript([
      userEntry("u1", null, "first @/a.md"),
      fileMention("m1", "u1", ["/a.md"]),
      userEntry("u2", "m1", "second @/b.md"),
      fileMention("m2", "u2", ["/b.md"]),
    ]);
    const users = out.filter((item) => item.role === "user");
    expect(users.map((item) => item.attachments)).toEqual([["/a.md"], ["/b.md"]]);
  });
});
