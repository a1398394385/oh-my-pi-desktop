// Skill commands must reach the base queue under the user's draft text: a
// promptCustomMessage call without queueChipText leaves details.__queueChipText
// unset, so the base's chip-text helper falls back to `content` — the expanded
// skill body. The queued frame and steer_consumed then carry that body, and the
// UI grows a second bubble while the real one never leaves its pending state.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/skill-queue-chip.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSkillInvocation } from "../host/rpc/prompt.ts";
import type { PoolEntry } from "../host/state.ts";

describe("runSkillInvocation", () => {
  test("queues the skill prompt under the draft the user typed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skill-chip-"));
    try {
      const skillDir = path.join(dir, "probe-skill");
      mkdirSync(skillDir, { recursive: true });
      const filePath = path.join(skillDir, "SKILL.md");
      writeFileSync(filePath, "---\nname: probe-skill\ndescription: probe\n---\nSKILL-BODY-MARKER\n");

      const captured: Array<{ queueChipText?: string }> = [];
      const dispatched = Promise.withResolvers<void>();
      const entry = {
        transcript: [],
        uiSockets: new Set(),
        manager: { getBranch: () => [] },
        session: {
          skillsSettings: { enableSkillCommands: true },
          skills: [{ name: "probe-skill", filePath, baseDir: skillDir }],
          promptCustomMessage: (_message: unknown, options?: { queueChipText?: string }) => {
            captured.push(options ?? {});
            dispatched.resolve();
            return Promise.resolve(true);
          },
        },
      } as unknown as PoolEntry;

      const text = "/skill:probe-skill 同时也看看这个吧";
      expect(runSkillInvocation(entry, "s1", { name: "probe-skill", args: "同时也看看这个吧", prompt: text })).toBe(true);
      await dispatched.promise;

      expect(captured[0]?.queueChipText).toBe(text);
      expect(entry.transcript[0]).toEqual({ role: "user", text });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
