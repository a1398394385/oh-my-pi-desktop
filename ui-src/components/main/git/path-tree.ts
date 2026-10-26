// Path → directory tree shared by the Git page's file lists: "a/b/c.ts" becomes
// a → b → c.ts, so a flat list of paths can also be rendered as a tree.

export interface PathTree<T> {
  dirs: Map<string, PathTree<T>>;
  files: T[];
}

/** Items → tree of directories; files keep their input order inside each dir. */
export function buildPathTree<T>(items: readonly T[], pathOf: (item: T) => string): PathTree<T> {
  const root: PathTree<T> = { dirs: new Map(), files: [] };
  for (const item of items) {
    const segments = pathOf(item).split("/");
    segments.pop();
    let node = root;
    for (const segment of segments) {
      let next = node.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push(item);
  }
  return root;
}
