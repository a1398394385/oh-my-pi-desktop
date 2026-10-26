// Changed-file list of one commit: flat rows or a directory tree, rendered in
// the Git page's detail panel. A row click hands the file to the right-panel
// commit-diff viewer (the page owns that call, so the callback stays here).
import Icon from "../../../Icon";
import { fileTypeIcon } from "../../../../ui/icons";
import type { GitCommitFileWire } from "../../../types/frames";
import { buildPathTree } from "./path-tree";
import TreeView from "./tree-view";

function FileRow({
  file,
  depth,
  label,
  binaryLabel,
  selected,
  onOpen,
}: {
  file: GitCommitFileWire;
  depth: number;
  label: string;
  binaryLabel: string;
  selected: boolean;
  onOpen: (file: GitCommitFileWire) => void;
}) {
  // A side with no change prints nothing: `+0`/`-0` on a one-sided file is noise.
  return (
    <button
      type="button"
      className={"gp-file" + (selected ? " on" : "")}
      style={{ paddingLeft: `${6 + depth * 12}px` }}
      title={file.path}
      onClick={() => onOpen(file)}
    >
      <Icon name={fileTypeIcon(file.path)} size={13} className="gp-file-ic" />
      <span className="gp-file-path">{label}</span>
      {file.binary ? (
        <span className="gp-file-binary">{binaryLabel}</span>
      ) : (
        <>
          {file.additions > 0 && <span className="gp-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="gp-del">-{file.deletions}</span>}
        </>
      )}
    </button>
  );
}

/** Flat list (full paths) or tree view (dirs + file names), per `view`. */
export default function FileList({
  files,
  view,
  binaryLabel,
  selectedPath,
  onOpen,
}: {
  files: readonly GitCommitFileWire[];
  view: "flat" | "tree";
  binaryLabel: string;
  /** Path open in the compare view, highlighted in both layouts. */
  selectedPath: string | null;
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
            selected={file.path === selectedPath}
            onOpen={onOpen}
          />
        ))}
      </>
    );
  }
  return (
    <TreeView
      tree={buildPathTree(files, (file) => file.path)}
      renderRow={(file, depth) => (
        <FileRow
          key={file.path}
          file={file}
          depth={depth}
          label={file.path.slice(file.path.lastIndexOf("/") + 1)}
          binaryLabel={binaryLabel}
          selected={file.path === selectedPath}
          onOpen={onOpen}
        />
      )}
      renderDir={(name, depth) => (
        <div className="gp-dir" style={{ paddingLeft: `${6 + depth * 12}px` }}>
          <Icon name="folder" size={12} />
          <span className="gp-dir-name">{name}</span>
        </div>
      )}
    />
  );
}
