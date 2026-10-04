// Edit row (edit/write/apply_patch single file) and the "Changes" group (consecutive edit
// events merged / a multi-file single event).
// Migrated from renderEdit/renderChange/renderChangeGroup/buildChangeBody in
// ui/tool-labels.js. Clicking a row expands/collapses the inline diff (ed-brief); the body
// prefers this call's own diff (ownDiffOf, arrives with tool_update) and only falls back to
// the git diff fetched from the host on demand (response re-renders via briefDiffCache).
import type { ToolItem } from "../../types/session";
import { useAppStore } from "../../store/index";
import { bumpGroupExpand, useGroupExpandVersion, rdExpand, chgExpand } from "../../store/groupExpand";
export { rdExpand, chgExpand };
import Icon from "../../Icon";
import { FileChip, Counts, EditBrief, useLift, openFileDiffInSidebar, uniqueFiles, Ellip, ReadRow, Spin, patchActiveItem, patchGroupSub, ownDiffOf } from "./parts";
import { splitPath } from "./util";
import { t } from "../../i18n";

// File list of the event: prefer the files backfilled by tool_update, otherwise fall back to args
function filesOf(item: ToolItem): string[] {
  return uniqueFiles(item.files?.length ? item.files : item.args?.files || (item.args?.path ? [item.args.path] : []));
}

// Expand (the collapse animation is handled by the caller's useLift): set the flag; with no
// per-call diff yet (tool still running / none arrived), fetch that file's git diff on demand.
// apply is the write channel that lands item fields: top-level rows and in-group sub-rows
// each go through their own copy chain
function expandDiff(item: ToolItem, path: string, apply: (fn: (it: ToolItem) => void) => void) {
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  apply((it) => {
    it.diffExpanded = true;
  });
  if (path && ownDiffOf(item, path) == null && s?.isGit && st.briefDiffCache.get(path) === undefined && st.briefDiffPending !== path) {
    useAppStore.setState({ briefDiffPending: path }); // silent write (the old code wrote S.xxx directly without notify)
    st.send({ type: "get_file_diff", cwd: s.cwd, path });
  }
}

// Edit row: pencil + "Edit/Write" label + file chip (clickable to open the right-panel diff) + line-count changes + expand arrow
export default function EditRow({ item }: { item: ToolItem }) {
  const path = filesOf(item)[0] || "";
  const [closing, close] = useLift();
  const open = item.diffExpanded && !closing;
  const toggle = () => {
    if (item.diffExpanded) close(() => patchActiveItem(item, (it) => { it.diffExpanded = false; }));
    else expandDiff(item, path, (fn) => patchActiveItem(item, fn));
  };
  return (
    <>
      <div className="act edit" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="pencil" size={15} />
        <span className="lbl">{(item.removed ?? 0) > 0 ? t("chat.editLabel") : t("chat.writeLabel")}</span>
        {path ? (
          <FileChip path={path} nameClass="ed-name" onNameClick={() => openFileDiffInSidebar(path)} />
        ) : (
          item.name || item.text || ""
        )}
        <Counts item={item} />
        {item.running && <Spin />}
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {item.diffExpanded && path && <EditBrief item={item} path={path} lift={closing} />}
    </>
  );
}

// In-group row UI of the change group: the full edit label (label text + file + line counts + expand arrow), minus the leading pencil icon
function ChangeRowUI({ sub, open, onToggle }: { sub: ToolItem; open: boolean; onToggle: () => void }) {
  const files = filesOf(sub);
  const path = files[0] || "";
  return (
    <div className="chg-item" style={{ cursor: "pointer" }} onClick={onToggle}>
      <span className="lbl">{(sub.removed ?? 0) > 0 ? t("chat.editLabel") : t("chat.writeLabel")}</span>
      {files.length > 1 ? (
        // One event touching multiple files (apply_patch): file chips laid out on a single
        // line, overlong lines end with an ellipsis
        <span className="chips-lane">
          {files.map((f) => <FileChip path={f} key={f} />)}{" "}
        </span>
      ) : path ? (
        <FileChip path={path} nameClass="ed-name" onNameClick={() => openFileDiffInSidebar(path)} />
      ) : (
        sub.name || sub.text || ""
      )}
      <Counts item={sub} />
      {sub.running && <Spin />}
      <span className={"ed-arrow" + (open ? " open" : "")}>
        <Icon name="chevronRight" />
      </span>
    </div>
  );
}

// One edit event inside a group = row + its inline diff expand body (expand state recorded on sub.diffExpanded)
function ChangeEntry({ sub }: { sub: ToolItem }) {
  const path = filesOf(sub)[0] || "";
  const [closing, close] = useLift();
  const open = !!sub.diffExpanded && !closing;
  const toggle = () => {
    if (sub.diffExpanded) close(() => patchGroupSub(sub, (it) => { it.diffExpanded = false; }));
    else expandDiff(sub, path, (fn) => patchGroupSub(sub, fn));
  };
  return (
    <>
      <ChangeRowUI sub={sub} open={open} onToggle={toggle} />
      {sub.diffExpanded && path && <EditBrief item={sub} path={path} lift={closing} />}
    </>
  );
}

// Change group expand state: keyed by the first item object in the group (defined in groupExpand.ts)

// "Changes · N files" title row: merged group of consecutive edit events, click to expand each edit downward
function ChangeGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // group expand state lives on a module-level WeakMap; the groupExpand channel bumps to trigger re-render
  const fileCount = uniqueFiles(subs.flatMap((g) => filesOf(g))).length; // 0 → "multiple files" fallback
  const [closing, close] = useLift();
  const open = chgExpand.has(subs[0]) && !closing;
  const toggle = () => {
    if (chgExpand.has(subs[0])) close(() => { chgExpand.delete(subs[0]); bumpGroupExpand(); });
    else {
      chgExpand.set(subs[0], true);
      bumpGroupExpand();
    }
  };
  return (
    <>
      <div className="act change" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="pencil" size={15} />
        <span className="lbl">{fileCount ? t("chat.changeFiles", { count: fileCount }) : t("chat.changeFilesMultiple")}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {chgExpand.has(subs[0]) && (
        <div className={"chg-body" + (closing ? " lift" : " drop")}>
          {subs.map((sub, i) => <ChangeEntry sub={sub} key={i} />)}
        </div>
      )}
    </>
  );
}

// A multi-file single edit event (apply_patch touching several files at once): label row + file chip list, no expansion
function ChangeSingle({ item }: { item: ToolItem }) {
  const files = filesOf(item);
  return (
    <div className="act change">
      <Icon name="pencil" size={15} />
      <span className="lbl">{files.length ? t("chat.changeFiles", { count: files.length }) : t("chat.changeFilesMultiple")}</span>
      {files.length > 0 && (
        <>
          {" "}<span className="sep">·</span>{" "}
          <span className="chips-lane">
            {files.map((f) => <FileChip path={f} key={f} />)}{" "}
          </span>
        </>
      )}
    </div>
  );
}

export function renderChange(item: ToolItem) {
  // Group members are guaranteed tool entries at runtime (grouping built in items.tsx); narrowed at the discriminated-union level
  if (item.group) return <ChangeGroup subs={item.group as ToolItem[]} />;
  return <ChangeSingle item={item} />;
}

// ---------- Lookup group (consecutive reads merged, same mechanism as the change group) ----------
// Expand state: a dedicated WeakMap (defined in groupExpand.ts)

// A single read row inside a group: shares ReadRow from parts.tsx (click to expand the read content)
function ReadEntry({ sub }: { sub: ToolItem }) {
  return <ReadRow item={sub} inGroup />;
}

// "Read · N files" title row: click to expand each read downward
function ReadGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // group expand state lives on a module-level WeakMap; the groupExpand channel bumps to trigger re-render
  const fileCount = uniqueFiles(subs.flatMap((s) => filesOf(s))).length; // 0 → "multiple files" fallback
  const [closing, close] = useLift();
  const open = rdExpand.has(subs[0]) && !closing;
  const toggle = () => {
    if (rdExpand.has(subs[0])) close(() => { rdExpand.delete(subs[0]); bumpGroupExpand(); });
    else {
      rdExpand.set(subs[0], true);
      bumpGroupExpand();
    }
  };
  return (
    <>
      <div className="act read" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="file" size={15} />
        <span className="lbl">{fileCount ? t("chat.readFiles", { count: fileCount }) : t("chat.readFilesMultiple")}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {rdExpand.has(subs[0]) && (
        <div className={"chg-body" + (closing ? " lift" : " drop")}>
          {subs.map((sub, i) => <ReadEntry sub={sub} key={i} />)}
        </div>
      )}
    </>
  );
}

export function renderReadGroup(item: ToolItem) {
  const subs = (item.group ?? []) as ToolItem[]; // same as renderChange: group members are guaranteed tool entries
  return <ReadGroup subs={subs} />;
}
