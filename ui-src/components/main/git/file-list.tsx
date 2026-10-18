// Changed-file list of one commit: flat rows or a directory tree, rendered in
// the Git page's detail panel. A row click hands the file to the right-panel
// commit-diff viewer (the page owns that call, so the callback stays here).
import Icon from "../../../Icon";
import type { GitCommitFileWire } from "../../../types/frames";

interface FileDirNode {
  dirs: Map<string, FileDirNode>;
  files: GitCommitFileWire[];
}

/** Paths → directory tree (ordered maps: rows keep the numstat order inside each dir). */
function buildFileTree(files: readonly GitCommitFileWire[]): FileDirNode[] {
  const root: FileDirNode = { dirs: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
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
    node.files.push(file);
  }
  return [root];
}

function FileRow({
  file,
  depth,
  label,
  binaryLabel,
  onOpen,
}: {
  file: GitCommitFileWire;
  depth: number;
  label: string;
  binaryLabel: string;
  onOpen: (file: GitCommitFileWire) => void;
}) {
  return (
    <button
      type="button"
      className="gp-file"
      style={{ paddingLeft: `${6 + depth * 12}px` }}
      title={file.path}
      onClick={() => onOpen(file)}
    >
      <span className="gp-file-path">{label}</span>
      {file.binary ? (
        <span className="gp-file-binary">{binaryLabel}</span>
      ) : (
        <>
          <span className="gp-add">+{file.additions}</span>
          <span className="gp-del">-{file.deletions}</span>
        </>
      )}
    </button>
  );
}

/** Directory rows (folder icon + name) then file rows, indented by depth. */
function DirRows({
  node,
  depth,
  binaryLabel,
  onOpen,
}: {
  node: FileDirNode;
  depth: number;
  binaryLabel: string;
  onOpen: (file: GitCommitFileWire) => void;
}) {
  return (
    <>
      {[...node.dirs].map(([name, sub]) => (
        <div key={`dir:${name}`}>
          <div className="gp-dir" style={{ paddingLeft: `${6 + depth * 12}px` }}>
            <Icon name="folder" size={12} />
            <span className="gp-dir-name">{name}</span>
          </div>
          <DirRows node={sub} depth={depth + 1} binaryLabel={binaryLabel} onOpen={onOpen} />
        </div>
      ))}
      {node.files.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          depth={depth}
          label={file.path.slice(file.path.lastIndexOf("/") + 1)}
          binaryLabel={binaryLabel}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/** Flat list (full paths) or tree view (dirs + file names), per `view`. */
export default function FileList({
  files,
  view,
  binaryLabel,
  onOpen,
}: {
  files: readonly GitCommitFileWire[];
  view: "flat" | "tree";
  binaryLabel: string;
  onOpen: (file: GitCommitFileWire) => void;
}) {
  if (view === "flat") {
    return (
      <>
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            depth={0}
            label={file.path}
            binaryLabel={binaryLabel}
            onOpen={onOpen}
          />
        ))}
      </>
    );
  }
  const [root] = buildFileTree(files);
  return <DirRows node={root} depth={0} binaryLabel={binaryLabel} onOpen={onOpen} />;
}
