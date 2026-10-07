// Welcome remote-connection dialog: manage OMP user-scope SSH hosts (ssh.json
// via the ssh_* RPCs), probe connectivity, and connect a remote workspace
// path (add_remote_workspace → add_project + setWelcomeProject, so the normal
// new-session flow takes over; the session itself gets the remote-workspace
// system-prompt section from host/session-lifecycle.ts).
// Reused surfaces: Dialog base + .confirm-box (app-wide dialog language),
// .inp inputs, .save-btn row buttons, .add-btn page-level new, .confirm-btn
// footer actions — per the settings-consistency rules these are global base
// classes, not dialog-private styles.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, setWelcomeProject } from "../../store";
import { placeMenu } from "../../shell";
import Icon from "../../Icon";
import { confirmDialog } from "../settings/common";
import { copyText } from "../main/sidebar/util";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";

// Host row shape from the ssh_hosts frame (see SshHostsFrame)
interface SshHostRow {
  name: string;
  host: string;
  username?: string;
  port?: number;
  keyPath?: string;
  description?: string;
  compat?: boolean;
}

const EMPTY_FORM = { name: "", host: "", username: "", port: "", keyPath: "", description: "" };

function hostSubtitle(h: SshHostRow): string {
  const user = h.username ? `${h.username}@` : "";
  const port = h.port && h.port !== 22 ? `:${h.port}` : "";
  return `${user}${h.host}${port}`;
}

// Probe/connect outcome panel. The text is selectable (user-select: text) and
// the raw ssh diagnostic is copied verbatim — no toast: a toast auto-hides in
// 2.2s, cannot be selected, and sits below the dialog mask (z 400 < 1000).
// Status rides on the border color, the copy button is the only chrome.
function ResultPanel({ ok, text, copyLabel, onCopy }: { ok: boolean; text: string; copyLabel: string; onCopy: () => void }) {
  return (
    <div className="rd-result" data-ok={ok}>
      <div className="rd-result-bar">
        {!ok && <span className="mcp-err-icon" title={text}>ⓘ</span>}
        <button type="button" className="save-btn" onClick={onCopy}>
          <Icon name="copy" size={12} />
          {copyLabel}
        </button>
      </div>
      <pre className="rd-result-body">{text}</pre>
    </div>
  );
}

// Workspace-path directory picker, portaled to <body> so it escapes the
// dialog's scrolling container and stacks above the dialog card (z 1000):
// anchored inside the card it was clipped/covered by the dialog chrome.
// Fixed-position + placeMenu, same recipe as BranchMenu.
function DirPicker({ anchor, dirs, activeIdx, onPick }: { anchor: HTMLElement; dirs: string[]; activeIdx: number; onPick: (name: string) => void }) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current!;
    placeMenu(menu, 0, 0);
    const rect = menu.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(a.bottom + 6, window.innerHeight - rect.height - 8));
    menu.style.width = a.width + "px";
    placeMenu(menu, left, top);
  });

  // Arrow-key navigation: keep the active row visible inside the scrolling menu
  // (same recipe as PaletteMenu).
  useLayoutEffect(() => {
    menuRef.current?.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  return createPortal(
    <div className="menu open rd-dirs" ref={menuRef}>
      {dirs.map((name, i) => (
        <div
          key={name}
          className={i === activeIdx ? "mi on" : "mi"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(name)}
        >
          <span className="mi-ic"><Icon name="folderLine" size={15} /></span>
          <span className="truncate">{name}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export default function RemoteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const sshHosts = useAppStore((s) => s.sshHosts);
  const sshTestResult = useAppStore((s) => s.sshTestResult);
  const remoteWorkspaceAdded = useAppStore((s) => s.remoteWorkspaceAdded);
  const [selected, setSelected] = useState<string | null>(sshHosts[0]?.name ?? null);
  // Add/edit form: null = closed (host list shown); "__new__" = creating; otherwise the edited host name
  const [editing, setEditing] = useState<string | null>(sshHosts.length === 0 ? "__new__" : null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formError, setFormError] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  // Probe/connect outcome rendered inline in the dialog. A toast cannot be used
  // for failures here: it auto-hides, forbids selection, and hides behind the
  // dialog mask — the user needs the ssh diagnostic to stay put and be copyable.
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const testTsRef = useRef(0);
  const addedTsRef = useRef(remoteWorkspaceAdded?.ts);
  // Directory-picker state: the base path the current listing describes and its
  // entries. Fetched by debounced ssh_list_dirs while the path input is focused.
  const [dirList, setDirList] = useState<{ path: string; dirs: string[] } | null>(null);
  const [pathFocused, setPathFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const pathWrapRef = useRef<HTMLDivElement>(null);
  const sshDirs = useAppStore((s) => s.sshDirs);
  // Base directory the typed path points into ("/" for "ho", "/home" for "/home/x").
  // Trailing slash is stripped to match the host's normalized echo (otherwise the
  // reply for a just-picked "/home/" would never match and the picker would close).
  const dirBase = remotePath.includes("/")
    ? (remotePath.slice(0, remotePath.lastIndexOf("/") + 1).replace(/\/+$/, "") || "/")
    : "";
  const dirBaseRef = useRef(dirBase);
  dirBaseRef.current = dirBase;
  // Picker rows: the dirs filtered by the typed tail of the current base. The
  // tail is the segment after the last separator — dirBase strips it, so
  // slicing by dirBase.length would leave the "/" in ("/home/" → tail "/")
  // and filter every dir out, killing the picker below a new subpath.
  const tail = remotePath.slice(remotePath.lastIndexOf("/") + 1);
  const matched = pathFocused && dirList && dirList.path === dirBase
    ? dirList.dirs.filter((n) => n.startsWith(tail)).slice(0, 50)
    : [];
  // Any keystroke re-filters the list: the active row returns to the top.
  useEffect(() => {
    setActiveIdx(0);
  }, [dirBase, remotePath]);

  useEffect(() => {
    send({ type: "ssh_list_hosts" });
  }, []);

  // Keep selection valid as the host list refreshes (save/remove replies)
  useEffect(() => {
    if (sshHosts.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (!sshHosts.some((h) => h.name === selected)) setSelected(sshHosts[0].name);
  }, [sshHosts, selected]);

  // The probe verdict describes the form as it was tested. Any field edit after
  // a green probe invalidates it: saving gated on a stale probe would persist an
  // untested target (the new flow requires test → save, not type-over-a-green).
  useEffect(() => {
    setResult(null);
  }, [form]);

  // Directory picker: while the path input is focused, list the base directory
  // of the typed path (debounced). In form mode this section only exists after
  // a green probe, so the inline fields are known-reachable credentials.
  useEffect(() => {
    if (!pathFocused || !dirBase) {
      setDirList(null);
      return;
    }
    const timer = setTimeout(() => {
      if (editing !== null) {
        send({ type: "ssh_list_dirs", host: form.host.trim(), username: form.username.trim(), port: form.port.trim(), keyPath: form.keyPath.trim(), path: dirBaseRef.current });
      } else if (selected) {
        send({ type: "ssh_list_dirs", name: selected, path: dirBaseRef.current });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [dirBase, pathFocused, editing, selected, form.host, form.username, form.port, form.keyPath]);

  // Listing replies: only the frame matching the base we're still typing into
  // lands (stale replies for abandoned prefixes are ignored, keeping the last
  // good list so the picker survives a mid-typing base change). No ts-dedup:
  // two host replies can share one millisecond, and the [sshDirs] dependency
  // already guarantees one run per distinct reply.
  useEffect(() => {
    if (!sshDirs) return;
    if (!sshDirs.ok) {
      if (sshDirs.path === dirBaseRef.current) setDirList(null);
      return;
    }
    if (sshDirs.path !== dirBaseRef.current) return;
    setDirList({ path: sshDirs.path, dirs: sshDirs.dirs ?? [] });
  }, [sshDirs]);

  // Probe replies: release the testing state and surface the outcome
  useEffect(() => {
    if (!sshTestResult || sshTestResult.ts === testTsRef.current) return;
    testTsRef.current = sshTestResult.ts;
    setTesting(false);
    if (sshTestResult.ok) setResult({ ok: true, text: t("ssh.testOk", { ms: sshTestResult.latencyMs }) });
    else setResult({ ok: false, text: `${t("ssh.testFail")}: ${sshTestResult.error ?? ""}` });
  }, [sshTestResult, t]);

  // Creation replies: on success register the stub as a project, select it for
  // the new session, and close; on failure keep the dialog open with the error
  useEffect(() => {
    if (!remoteWorkspaceAdded || remoteWorkspaceAdded.ts === addedTsRef.current) return;
    addedTsRef.current = remoteWorkspaceAdded.ts;
    setConnecting(false);
    if (!remoteWorkspaceAdded.ok || !remoteWorkspaceAdded.cwd) {
      setResult({ ok: false, text: `${t("ssh.connFail")}: ${remoteWorkspaceAdded.error ?? ""}` });
      return;
    }
    send({ type: "add_project", cwd: remoteWorkspaceAdded.cwd });
    setWelcomeProject(remoteWorkspaceAdded.cwd);
    toast(t("ssh.connectedToast", { label: `${remoteWorkspaceAdded.host}:${remoteWorkspaceAdded.remotePath}` }));
    onClose();
  }, [remoteWorkspaceAdded, onClose, t]);

  const startEdit = (name: string | null, host?: SshHostRow) => {
    setEditing(name ?? "__new__");
    setFormError("");
    setForm(
      host
        ? {
            name: host.name,
            host: host.host,
            username: host.username ?? "",
            port: host.port ? String(host.port) : "",
            keyPath: host.keyPath ?? "",
            description: host.description ?? "",
          }
        : { ...EMPTY_FORM },
    );
  };

  const saveHost = () => {
    if (!form.name.trim() || !form.host.trim()) {
      setFormError(t("ssh.nameAddressRequired"));
      return;
    }
    send({
      type: "ssh_save_host",
      name: form.name.trim(),
      host: form.host.trim(),
      username: form.username.trim(),
      port: form.port.trim(),
      keyPath: form.keyPath.trim(),
      description: form.description.trim(),
    });
    setSelected(form.name.trim());
    setEditing(null);
  };

  const removeHost = async (h: SshHostRow) => {
    if (!(await confirmDialog({ title: t("ssh.deleteHost"), message: h.name, confirmText: t("common.delete"), danger: true }))) return;
    send({ type: "ssh_remove_host", name: h.name });
  };

  // Copy the raw diagnostic verbatim — the user pastes it into a bug report.
  const copyResult = () => {
    if (!result) return;
    copyText(result.text).then(
      () => toast(t("ssh.copiedResult")),
      () => toast(t("ssh.copyResultFailed")),
    );
  };

  const testTarget = () => {
    if (editing !== null) {
      // Inline form: probe the typed fields without saving
      if (!form.host.trim()) {
        setFormError(t("ssh.nameAddressRequired"));
        return;
      }
      setTesting(true);
      setResult(null);
      send({
        type: "ssh_test_host",
        host: form.host.trim(),
        username: form.username.trim(),
        port: form.port.trim(),
        keyPath: form.keyPath.trim(),
      });
    } else if (selected) {
      setTesting(true);
      setResult(null);
      send({ type: "ssh_test_host", name: selected });
    }
  };

  // Complete the typed path to a picked directory; the trailing "/" makes the
  // next listing open that directory — picking walks the tree one hop at a
  // time. dirBase has no trailing slash ("/" for root, "/home" for "/home/x"),
  // so it must be re-inserted between base and name.
  const pickDir = (name: string) => {
    setRemotePath(`${dirBase === "/" ? "" : dirBase}/${name}/`);
  };

  const connect = () => {
    if (!selected || !remotePath.trim()) return;
    setConnecting(true);
    setResult(null);
    send({ type: "add_remote_workspace", host: selected, remotePath: remotePath.trim() });
    // Safety release: a host-side hang must not freeze the button forever
    setTimeout(() => setConnecting(false), 30_000);
  };

  const selectedHost = sshHosts.find((h) => h.name === selected) ?? null;

  const labelStyle = { fontSize: "var(--ui-fs-sm)", color: "var(--dim)", marginBottom: "6px", display: "block" } as const;
  const rowStyle = { display: "flex", gap: "8px", marginBottom: "10px" } as const;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="confirm-box"
        style={{ width: "650px", maxWidth: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="confirm-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="server" size={16} />
          <span>{t("ssh.title")}</span>
        </DialogTitle>
        <div style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)", marginTop: "2px" }}>{t("ssh.desc")}</div>

        <div style={{ flex: 1, minHeight: 0, marginTop: "14px", overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column" }}>
          {/* Host section: saved rows (click to select) or the add/edit form */}
          <div style={labelStyle}>{t("ssh.hostSection")}</div>
          {editing === null ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {sshHosts.length === 0 && <div style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)", padding: "10px 0" }}>{t("ssh.noHosts")}</div>}
              {sshHosts.map((h) => (
                <div
                  key={h.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "7px 10px",
                    borderRadius: "var(--r-sm)",
                    cursor: "pointer",
                    background: h.name === selected || hovered === h.name ? "var(--panel-2)" : undefined,
                  }}
                  onClick={() => setSelected(h.name)}
                >
                  <span className="flex-none flex items-center justify-center" style={{ color: h.name === selected ? "var(--accent)" : "var(--dim)" }}>
                    <Icon name="server" size={15} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div style={{ fontWeight: 500, fontSize: "var(--ui-fs-base)" }}>{h.name}</div>
                    <div style={{ color: "var(--dim)", fontSize: "var(--ui-fs-sm)" }} className="truncate">
                      {hostSubtitle(h)}
                      {h.description ? ` — ${h.description}` : ""}
                    </div>
                  </div>
                  <button className="save-btn" style={{ flex: "none" }} onClick={(e) => { e.stopPropagation(); startEdit(h.name, h); }}>{t("ssh.edit")}</button>
                  <button className="save-btn danger" style={{ flex: "none" }} onClick={(e) => { e.stopPropagation(); void removeHost(h); }}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
              <button className="add-btn" style={{ marginTop: "6px" }} onClick={() => startEdit(null)}>
                <Icon name="plus" size={13} />
                {t("ssh.newHost")}
              </button>
            </div>
          ) : (
            <div className="rd-form" style={{ display: "flex", flexDirection: "column" }}>
              <div style={rowStyle}>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.nameLabel")}</label>
                  <input className="inp w-full" value={form.name} placeholder={t("ssh.namePh")} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.userLabel")}</label>
                  <input className="inp w-full" value={form.username} placeholder={t("ssh.userPh")} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
                </div>
              </div>
              <div style={rowStyle}>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.addressLabel")}</label>
                  <input className="inp w-full" value={form.host} placeholder={t("ssh.addressPh")} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
                </div>
                <div style={{ width: "110px", flex: "none" }}>
                  <label style={labelStyle}>{t("ssh.portLabel")}</label>
                  <input className="inp w-full" value={form.port} placeholder={t("ssh.portPh")} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
                </div>
              </div>
              <div style={rowStyle}>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.keyPathLabel")}</label>
                  <input className="inp w-full" value={form.keyPath} placeholder={t("ssh.keyPathPh")} onChange={(e) => setForm((f) => ({ ...f, keyPath: e.target.value }))} />
                </div>
              </div>
              <div style={rowStyle}>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.descLabel")}</label>
                  <input className="inp w-full" value={form.description} placeholder={t("ssh.descPh")} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
                </div>
              </div>
              {formError && <div style={{ color: "var(--err)", fontSize: "var(--ui-fs-sm)", marginBottom: "10px" }}>{formError}</div>}
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className={result?.ok ? "save-btn rd-test-ok" : "save-btn"}
                  onClick={testTarget}
                  disabled={testing}
                  title={result?.ok ? result.text : undefined}
                >
                  {testing ? t("ssh.testing") : t("ssh.testBtn")}
                </button>
                <button className="save-btn" style={{ marginLeft: "auto" }} onClick={saveHost} disabled={!result?.ok} title={result?.ok ? undefined : t("ssh.saveAfterTest")}>{t("ssh.saveHost")}</button>
                {sshHosts.length > 0 && (
                  <button className="save-btn" onClick={() => setEditing(null)}>{t("ssh.cancelForm")}</button>
                )}
              </div>
            </div>
          )}

          {/* Path section: gated by reachability — in list mode a selected host,
              in form mode only after a green probe (the new flow: test → save) */}
          {(editing === null ? Boolean(selectedHost) : result?.ok === true) && (
            <>
              <div style={{ ...labelStyle, marginTop: "16px" }}>{t("ssh.pathSection")}</div>
              <div ref={pathWrapRef}>
                <input
                  className="inp w-full"
                  value={remotePath}
                  placeholder={t("ssh.pathPh")}
                  disabled={!selectedHost && editing === null}
                  onChange={(e) => setRemotePath(e.target.value)}
                  onFocus={() => setPathFocused(true)}
                  onBlur={() => setTimeout(() => setPathFocused(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && dirList) {
                      // Close the picker only; without the stop the dialog's own
                      // Esc handling would dismiss the whole dialog.
                      e.stopPropagation();
                      setDirList(null);
                      return;
                    }
                    // Keyboard picking: arrows move the active row, Tab/Enter
                    // complete to it (Tab keeps focus so completion can chain).
                    if (matched.length > 0) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const step = e.key === "ArrowDown" ? 1 : matched.length - 1;
                        setActiveIdx((i) => (i + step) % matched.length);
                        return;
                      }
                      if (e.key === "Tab" || e.key === "Enter") {
                        e.preventDefault();
                        pickDir(matched[Math.min(activeIdx, matched.length - 1)]);
                        return;
                      }
                    }
                    if (e.key === "Enter" && selected && remotePath.trim() && editing === null) {
                      e.preventDefault();
                      connect();
                    }
                  }}
                />
                {matched.length > 0 && pathWrapRef.current && (
                  <DirPicker
                    anchor={pathWrapRef.current}
                    dirs={matched}
                    activeIdx={Math.min(activeIdx, matched.length - 1)}
                    onPick={pickDir}
                  />
                )}
              </div>
              {selectedHost && editing === null && (
                <div style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)", marginTop: "6px" }} className="truncate">
                  ssh://{selectedHost.name}
                  {remotePath.trim().replace(/\/+$/, "") || "/…"}
                </div>
              )}
            </>
          )}

          {/* Probe/connect failure outcome. Success needs no panel — the test
              button carries a pale-green tint instead (see .rd-test-ok); the
              user only needs the ssh diagnostic to stay put and be copyable. */}
          {result && !result.ok && <ResultPanel ok={result.ok} text={result.text} copyLabel={t("ssh.copyResult")} onCopy={copyResult} />}
        </div>

        <DialogFooter className="confirm-actions" style={{ marginTop: "16px" }}>
          <button className="confirm-btn" onClick={onClose}>{t("ssh.cancel")}</button>
          <button className="confirm-btn" onClick={connect} disabled={editing !== null || !selected || !remotePath.trim() || connecting} title={editing !== null ? t("ssh.saveFirst") : undefined}>
            {connecting ? t("ssh.connecting") : t("ssh.connect")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
