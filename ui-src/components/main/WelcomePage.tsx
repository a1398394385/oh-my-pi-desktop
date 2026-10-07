// Welcome page (new task): expand-out cards + project/branch pickers + input (Composer
// mounted inside the outer card).
// Migrated from ui/welcome.js (324 lines). Visibility routed by App per isCreatingNew
// (replacing the old physical composer relocation).
// Contract: project data getAvailableProjects(), branch data newSessionBranches, time-of-day
// greeting.
// Menu visibility is local state: projMenu/branchMenu hold pop coordinates (pop upward,
// bottom edge 4px above the capsule's top, mirroring the old offsetLeft /
// clientHeight-offsetTop positioning); the two menus are mutually exclusive,
// closed by window click / blur (the global close semantics of the old shell.js closeAllMenus).
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useAppStore, setWelcomeProject, pathBase } from "../../store";
import { t } from "../../i18n";
import Icon from "../../Icon";
import Composer from "../Composer";
import ProjectMenu from "../welcome/ProjectMenu";
import BranchMenu from "../welcome/BranchMenu";
import RemoteDialog from "../welcome/RemoteDialog";

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return t("misc.greetMorning");
  if (h >= 11 && h < 14) return t("misc.greetNoon");
  if (h >= 14 && h < 19) return t("misc.greetAfternoon");
  return t("misc.greetEvening");
}

export default function Welcome() {
  // Three new-session fields (git_branches frames land fresh references; field subscriptions notice)
  const newSessionProject = useAppStore((s) => s.newSessionProject);
  const newSessionIsGit = useAppStore((s) => s.newSessionIsGit);
  const newSessionBranch = useAppStore((s) => s.newSessionBranch);
  const newSessionBranches = useAppStore((s) => s.newSessionBranches);
  // null = closed; when open, holds the trigger button's viewport coords; the menu portals to
  // body then positions itself
  const [projMenu, setProjMenu] = useState<DOMRect | null>(null);
  const [branchMenu, setBranchMenu] = useState<DOMRect | null>(null);
  const [remoteDlg, setRemoteDlg] = useState(false);

  const menuOpen = !!projMenu || !!branchMenu;

  // Global close: click anywhere outside the menu / window blur (the open actions and
  // in-menu clicks already stopPropagation, so no accidental closes)
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setProjMenu(null);
      setBranchMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen]);

  // Click while open = close; before exclusively opening the other menu, close all current
  // ones (mirrors the old closeAllMenus precondition)
  const toggleProjMenu = (e: MouseEvent) => {
    e.stopPropagation();
    if (projMenu) return setProjMenu(null);
    setBranchMenu(null);
    setProjMenu(e.currentTarget.getBoundingClientRect());
  };

  const toggleBranchMenu = (e: MouseEvent) => {
    e.stopPropagation();
    if (branchMenu) return setBranchMenu(null);
    setProjMenu(null);
    setBranchMenu(e.currentTarget.getBoundingClientRect());
  };

  // Remote workspace stubs display their host:path label instead of the stub dir basename;
// the app-owned default workspace shows its fixed label (its dir name is internal).
  const defaultWorkspace = useAppStore((s) => s.defaultWorkspace);
  const projIsDefault = Boolean(defaultWorkspace) && newSessionProject === defaultWorkspace;
  const projEntry = useAppStore((s) => s.diskProjects).find((p) => p.cwd === newSessionProject);
  const projName = projIsDefault
    ? t("misc.defaultProject")
    : newSessionProject
      ? projEntry?.remoteLabel || pathBase(newSessionProject) || newSessionProject
      : t("misc.projectFallback");
  const projIsRemote = projEntry?.remote === true;

  return (
    <div id="welcomeScreen" className="flex-1 min-h-0 flex flex-col items-center justify-center overflow-y-auto pt-[30px] px-[20px] pb-[80px]">
      <div className="w-full max-w-[min(720px,100%)] flex flex-col items-center">
        <div className="text-[26px] font-medium text-text mb-[28px] tracking-[0.5px] text-center select-none" /* style-token-ignore */ id="welcomeTitle">{greeting()}</div>
        <div className="wb-wrapper w-full relative flex flex-col" id="wbContainer">
          <div
            id="wbBackCard"
            className="wb-back-card"
          >
            {/* Bottom 31px padding is the overlap budget + bottom symmetry: the input card is
                pulled up by negative margin (-25px) to cover it, with 7px each between the
                capsule and the bottom card's top and the input card's top */}
            <div className="wb-head flex items-center gap-[8px] pt-[6px] px-[6px] pb-[31px]">
              <button
                id="wbProjectBtn"
                className={"wb-pill" + (projMenu ? " active" : "")}
                title={t("misc.projectDirTitle", { path: newSessionProject })}
                onClick={toggleProjMenu}
              >
                {/* Project reset button: ZCode-style hover icon swap (hidden by default; on
                    capsule hover folder fades out, × fades in); clicking picks the default project */}
                <span
                  className="wb-proj-clear"
                  id="wbProjClear"
                  title={t("misc.defaultProject")}
                  onClick={(e) => {
                    e.stopPropagation();
                    // The default row is app-owned and always the fixed first row; picking it
                    // replaces the old "clear to no project" semantics.
                    if (defaultWorkspace) setWelcomeProject(defaultWorkspace);
                  }}
                >
                  <Icon name="xmark" size={12} />
                </span>
                {/* Folder icon at the same visual size as the picker rows' icons */}
                <span className="wb-ic-folder"><Icon name={projIsDefault ? "comment" : projIsRemote ? "server" : "folder"} size={15} /></span>
                <span id="wbProjectName">{projName}</span>
                <span className="caret caret-svg"><Icon name="caret" /></span>
              </button>
              {newSessionIsGit && (
                <button
                  id="wbBranchBtn"
                  className={"wb-pill" + (branchMenu ? " active" : "")}
                  title={t("misc.gitBranchTitle", { branch: newSessionBranch || "main" })}
                  onClick={toggleBranchMenu}
                >
                  <Icon name="branch" />
                  <span id="wbBranchName">{newSessionBranch || "main"}</span>
                  <span className="caret caret-svg"><Icon name="caret" /></span>
                </button>
              )}
            </div>
          </div>
          {/* Two-level overlapping cards (ZCode queue-card ↔ dock geometry): the capsule card
              (.wb-back-card) on top, the input card (#composer.in-welcome) pulled up by
              negative margin to cover its lower edge, the project/branch capsules exposed in
              the capsule card's upper half; the two cards are siblings, same width,
              edges aligned.*/}
          <Composer inWelcome={true} />
          {projMenu && <ProjectMenu anchorRect={projMenu} onClose={() => setProjMenu(null)} onOpenRemote={() => setRemoteDlg(true)} />}
          {branchMenu && <BranchMenu anchorRect={branchMenu} onClose={() => setBranchMenu(null)} branches={newSessionBranches} current={newSessionBranch} cwd={newSessionProject} />}
          {remoteDlg && <RemoteDialog onClose={() => setRemoteDlg(false)} />}
        </div>
      </div>
    </div>
  );
}
