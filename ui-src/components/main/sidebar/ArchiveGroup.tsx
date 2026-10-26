// Archive view group: mirrors the project group's head/kids structure so archived sessions
// read exactly like the project list (folder icon, name, 0fr<->1fr expand animation, 5-row
// default limit with "show more"), minus the project-only affordances (drag reorder,
// new-session ＋, "⋯" remove). Expansion state is shared with the project view (same
// expandedProjects set + the same set_project_expanded persistence), so a project stays
// expanded/collapsed across both views.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, pathBase, type TimerHandle } from "../../../store";
import { REMOTE } from "../../../store/ws";
import Icon from "../../../Icon";
import { ProjKids, projectIconName } from "./ProjGroup";
import type { ProjectInfo } from "./ProjGroup";
import type { RenamingState, SessionRowCallbacks } from "./SessionRow";

export default function ArchiveGroup({ p, rowProps, renaming, shortcuts, ctxKey }: {
  p: ProjectInfo;
  rowProps: SessionRowCallbacks;
  renaming: RenamingState | null;
  shortcuts?: Map<string, string>;
  ctxKey?: string | null;
}) {
  const { t } = useTranslation();
  const expandedProjects = useAppStore((s) => s.expandedProjects);
  const expanded = expandedProjects.has(p.cwd);
  const [showKids, setShowKids] = useState(expanded); // render immediately on first mount without animation (mirrors ProjGroup)
  const [closing, setClosing] = useState(false);

  // Mount kids on expand / delay unmount on collapse (remove only after the 0.3s collapse
  // animation finishes). Same ref-owned timer as ProjGroup: the effect re-runs when
  // setClosing(true) lands, and a cleanup clearTimeout would strand .closing (an ~8px box)
  // between the collapsed row and the next group.
  const closeTimer = useRef<TimerHandle | null>(null);
  useEffect(() => {
    if (expanded) {
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      if (!showKids || closing) {
        setClosing(false);
        setShowKids(true);
      }
    } else if (showKids && !closing && !closeTimer.current) {
      setClosing(true);
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        setShowKids(false);
        setClosing(false);
      }, 310);
    }
  }, [expanded, showKids, closing]);

  // Same toggle chain as ProjGroup: host persistence + fresh-reference state swap; re-expanding resets paging
  const toggle = () => {
    const st = useAppStore.getState();
    const wasExpanded = st.expandedProjects.has(p.cwd);
    const nextExpanded = new Set(st.expandedProjects);
    const nextLimits = wasExpanded ? st.projectLimits : new Map(st.projectLimits);
    if (wasExpanded) nextExpanded.delete(p.cwd);
    else {
      nextExpanded.add(p.cwd);
      nextLimits.delete(p.cwd);
    }
    if (!REMOTE) send({ type: "set_project_expanded", cwd: p.cwd, expanded: !wasExpanded }); // host-side persistence; remote stays read-only
    useAppStore.setState({ expandedProjects: nextExpanded, projectLimits: nextLimits });
  };

  // Remote SSH workspace stubs show host:path (the stub path stays in the tooltip);
  // the default row shows a fixed label instead of its dir name ("default").
  const name = p.isDefault ? t("misc.defaultProject") : p.name || p.remoteLabel || pathBase(p.cwd) || p.cwd;
  return (
    <>
      <div className={"proj" + (expanded ? "" : " collapsed")} data-cwd={p.cwd} onClick={() => toggle()}>
        {/* the default row's comment icon skips the CJK 1.2× stretch so it keeps the same
            visual size as the picker rows' icons */}
        <span className={"fic" + (!p.isDefault && /[\u4e00-\u9fa5]/.test(name) ? " is-cjk" : "")}><Icon name={projectIconName(p, expanded)} size={16} /></span>
        <span className="pname" title={p.remoteLabel ? `${p.remoteLabel}\n${p.cwd}` : p.cwd}>{name}</span>
      </div>
      {showKids && <ProjKids p={p} animate={expanded && !closing} closing={closing} ty={0} dragging={false} isDragSelf={false} rowProps={rowProps} renaming={renaming} shortcuts={shortcuts} ctxKey={ctxKey} />}
    </>
  );
}
