// Session entry tree state, owned by the middle-column tree page.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type { EntryTreeNode } from "../types/frames";

export interface EntryTreeSlice {
  entryTree: { sessionId: string | null; leafId: string | null; roots: EntryTreeNode[] } | null;
  entryTreePending: boolean;
  entryTreeFor: string | null;
  navFrom: string | null; // origin of navigate_tree: "fork" (output-tail fork) or null (tree-page jump); decides the receipt message
  entryTreeNav: boolean; // navigate_tree in flight (double-click guard)
}

export const createEntryTreeSlice: StateCreator<AppStore, [], [], EntryTreeSlice> = () => ({
  entryTree: null, // in-session entry tree (/tree): { sessionId, leafId, roots }
  entryTreePending: false,
  entryTreeFor: null,
  navFrom: null, // origin of navigate_tree: "fork" (output-tail fork) or null (tree-page jump); decides the receipt message
  entryTreeNav: false, // navigate_tree in flight (double-click guard)
});
