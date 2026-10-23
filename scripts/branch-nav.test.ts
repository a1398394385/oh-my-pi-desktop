// Branch pager pure helpers (ui-src/components/chat/branch-nav.ts): fork-point
// detection on the active path, host-bubble mounting rules (first visible
// bubble below the fork child; nearer forks supersede older ones), sibling
// leaf targeting and the cyclic switch. Children order is trusted as the wire
// order (base sorts by entry timestamp).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/branch-nav.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import {
  computeBranchNav,
  cycleSiblingLeaf,
  deepestLeafId,
  ROOT_FORK_ID,
  type BranchNavNode,
} from "../ui-src/components/chat/branch-nav";

function n(id: string, role?: string, text?: string, children?: BranchNavNode[]): BranchNavNode {
  return { id, role, text, children };
}

describe("computeBranchNav mounting", () => {
  test("linear chain without forks mounts nothing", () => {
    const roots = [n("u1", "user", "hi", [n("a1", "assistant", "yo", [n("u2", "user", "again")])])];
    const map = computeBranchNav(roots, "u2");
    expect(map.size).toBe(0);
  });

  test("missing / stale leaf mounts nothing", () => {
    const roots = [n("u1", "user", "hi")];
    expect(computeBranchNav(roots, null).size).toBe(0);
    expect(computeBranchNav(roots, "nope").size).toBe(0);
  });

  test("root-level fork: pager on the active root's first bubble, k/n over roots", () => {
    // two roots: r1 (abandoned), r2 (active) whose direct child chain has no
    // bubble until u2b — the pager mounts on u2b, the first visible bubble
    const r1 = n("r1", "user", "old", [n("a1", "assistant", "old reply", [n("leaf1", "assistant", "tail")])]);
    const r2 = n("r2", "toolCall", undefined, [n("t1", "toolCall", undefined, [n("u2b", "user", "ask")])]);
    const map = computeBranchNav([r1, r2], "u2b");
    const info = map.get("u2b")!;
    expect(info.forkId).toBe(ROOT_FORK_ID);
    expect(info.index).toBe(1); // 0-based, display k = index+1 = 2
    expect(info.total).toBe(2);
    expect(info.siblingLeaves).toEqual(["leaf1", "u2b"]);
  });

  test("fork child that is itself a bubble hosts the pager", () => {
    const parent = n("p", "assistant", "text", [
      n("b1", "user", "branch one"),
      n("b2", "user", "branch two"),
    ]);
    const roots = [n("root", "user", "hi", [parent])];
    const map = computeBranchNav(roots, "b2");
    expect(map.size).toBe(1);
    const info = map.get("b2")!;
    expect(info.forkId).toBe("p");
    expect(info.index).toBe(1);
    expect(info.total).toBe(2);
  });

  test("non-bubble entries are descended past (tool calls, settings, empty/junk assistants)", () => {
    const kid = (leaf: string) =>
      n("k" + leaf, "toolCall", undefined, [n("e" + leaf, "assistant", ".", [n(leaf, "assistant", "real text")])]);
    const roots = [n("root", "user", "hi", [kid("L1"), kid("L2"), kid("L3")])];
    const map = computeBranchNav(roots, "L2");
    expect(map.size).toBe(1);
    const info = map.get("L2")!; // junk-text assistant e2 is skipped, L2 hosts
    expect(info.index).toBe(1);
    expect(info.total).toBe(3);
    expect(info.siblingLeaves).toEqual(["L1", "L2", "L3"]);
  });

  test("a nearer fork supersedes an older pending one (old fork mounts nothing)", () => {
    // fork A at kid level; below its active child sits a toolCall, then fork B;
    // the first bubble appears only after fork B → B wins, A gets no host
    const kidB1 = n("b1", "toolCall", undefined, [n("h", "user", "host")]);
    const kidB2 = n("b2", "toolCall", undefined, [n("z", "user", "other")]);
    const kidA1 = n("a1", "toolCall", undefined, [kidB1, kidB2]);
    const kidA2 = n("a2", "toolCall", undefined, [n("q", "user", "sibling of A")]);
    const roots = [n("root", "user", "hi", [kidA1, kidA2])];
    const map = computeBranchNav(roots, "h");
    expect(map.size).toBe(1);
    const info = map.get("h")!;
    expect(info.forkId).toBe("a1"); // fork B's parent, not root's fork at "root"
    expect(info.index).toBe(0);
    expect(info.total).toBe(2);
    expect(info.siblingLeaves).toEqual(["h", "z"]);
  });

  test("two independent forks on one path each mount their own host", () => {
    // fork 1 at root level → host on the active root (a user bubble); deeper
    // fork 2 → host on its branch's first bubble
    const deep11 = n("d11", "user", "deep one");
    const deep12 = n("d12", "user", "deep two");
    const mid = n("mid", "toolCall", undefined, [deep11, deep12]);
    const r1 = n("r1", "user", "root one", [n("t", "toolCall", undefined, [n("leaf1", "user", "l1")])]);
    const r2 = n("r2", "user", "root two", [mid]);
    const map = computeBranchNav([r1, r2], "d12");
    expect(map.size).toBe(2);
    expect(map.get("r2")!.forkId).toBe(ROOT_FORK_ID);
    expect(map.get("r2")!.index).toBe(1);
    expect(map.get("d12")!.forkId).toBe("mid");
    expect(map.get("d12")!.index).toBe(1);
  });

  test("fork whose subtree holds no visible bubble mounts nothing", () => {
    const kid1 = n("k1", "toolCall", undefined, [n("l1", "toolResult", "out")]);
    const kid2 = n("k2", "toolCall", undefined, [n("l2", "toolResult", "out")]);
    const roots = [n("root", "user", "hi", [kid1, kid2])];
    expect(computeBranchNav(roots, "l2").size).toBe(0);
  });
});

describe("sibling leaf targeting", () => {
  test("deepestLeafId follows first children through nested forks", () => {
    const tree = n("a", undefined, undefined, [
      n("b1", undefined, undefined, [n("c1", undefined, undefined, [n("d1")])]),
      n("b2", undefined, undefined, [n("c2")]),
    ]);
    expect(deepestLeafId(tree)).toBe("d1"); // a → b1 → c1 → d1
    expect(deepestLeafId(tree.children![1])).toBe("c2");
  });

  test("cycleSiblingLeaf wraps in both directions", () => {
    const leaves = ["x", "y", "z"];
    expect(cycleSiblingLeaf(leaves, 0, -1)).toBe("z");
    expect(cycleSiblingLeaf(leaves, 2, 1)).toBe("x");
    expect(cycleSiblingLeaf(leaves, 1, 1)).toBe("z");
    expect(cycleSiblingLeaf(leaves, 1, -1)).toBe("x");
  });
});
