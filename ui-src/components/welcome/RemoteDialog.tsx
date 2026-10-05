// Welcome remote-connection dialog: manage OMP user-scope SSH hosts (ssh.json
// via the ssh_* RPCs), probe connectivity, and connect a remote workspace
// path (add_remote_workspace → add_project + setWelcomeProject, so the normal
// new-session flow takes over; the session itself gets the remote-workspace
// system-prompt section from host/session-lifecycle.ts).
// Reused surfaces: Dialog base + .confirm-box (app-wide dialog language),
// .inp inputs, .save-btn row buttons, .add-btn page-level new, .confirm-btn
// footer actions — per the settings-consistency rules these are global base
// classes, not dialog-private styles.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, setWelcomeProject } from "../../store";
import Icon from "../../Icon";
import { confirmDialog } from "../settings/common";
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
  const testTsRef = useRef(0);
  const addedTsRef = useRef(remoteWorkspaceAdded?.ts);

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

  // Probe replies: release the testing state and surface the outcome
  useEffect(() => {
    if (!sshTestResult || sshTestResult.ts === testTsRef.current) return;
    testTsRef.current = sshTestResult.ts;
    setTesting(false);
    if (sshTestResult.ok) toast(t("ssh.testOk", { ms: sshTestResult.latencyMs }));
    else toast(`${t("ssh.testFail")}: ${sshTestResult.error ?? ""}`);
  }, [sshTestResult, t]);

  // Creation replies: on success register the stub as a project, select it for
  // the new session, and close; on failure keep the dialog open with the error
  useEffect(() => {
    if (!remoteWorkspaceAdded || remoteWorkspaceAdded.ts === addedTsRef.current) return;
    addedTsRef.current = remoteWorkspaceAdded.ts;
    setConnecting(false);
    if (!remoteWorkspaceAdded.ok || !remoteWorkspaceAdded.cwd) {
      toast(`${t("ssh.connFail")}: ${remoteWorkspaceAdded.error ?? ""}`);
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

  const testTarget = () => {
    if (editing !== null) {
      // Inline form: probe the typed fields without saving
      if (!form.host.trim()) {
        setFormError(t("ssh.nameAddressRequired"));
        return;
      }
      setTesting(true);
      send({
        type: "ssh_test_host",
        host: form.host.trim(),
        username: form.username.trim(),
        port: form.port.trim(),
        keyPath: form.keyPath.trim(),
      });
    } else if (selected) {
      setTesting(true);
      send({ type: "ssh_test_host", name: selected });
    }
  };

  const connect = () => {
    if (!selected || !remotePath.trim()) return;
    setConnecting(true);
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
        style={{ width: "520px", maxWidth: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="confirm-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="cloud" size={16} />
          <span>{t("ssh.title")}</span>
        </DialogTitle>
        <div style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)", marginTop: "2px" }}>{t("ssh.desc")}</div>

        <div style={{ flex: 1, minHeight: 0, marginTop: "14px", overflowY: "auto", display: "flex", flexDirection: "column" }}>
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
                    <Icon name="cloud" size={15} />
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
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={rowStyle}>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.nameLabel")}</label>
                  <input className="inp w-full" value={form.name} placeholder={t("ssh.namePh")} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.addressLabel")}</label>
                  <input className="inp w-full" value={form.host} placeholder={t("ssh.addressPh")} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
                </div>
              </div>
              <div style={rowStyle}>
                <div className="flex-1 min-w-0">
                  <label style={labelStyle}>{t("ssh.userLabel")}</label>
                  <input className="inp w-full" value={form.username} placeholder={t("ssh.userPh")} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
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
                <button className="save-btn" onClick={saveHost}>{t("ssh.saveHost")}</button>
                <button className="save-btn" onClick={testTarget} disabled={testing}>{testing ? t("ssh.testing") : t("ssh.testBtn")}</button>
                {sshHosts.length > 0 && (
                  <button className="save-btn" onClick={() => setEditing(null)}>{t("ssh.cancelForm")}</button>
                )}
              </div>
            </div>
          )}

          {/* Path section: only meaningful with a selected host */}
          <div style={{ ...labelStyle, marginTop: "16px" }}>{t("ssh.pathSection")}</div>
          <input
            className="inp w-full"
            value={remotePath}
            placeholder={t("ssh.pathPh")}
            disabled={!selectedHost}
            onChange={(e) => setRemotePath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && selected && remotePath.trim()) {
                e.preventDefault();
                connect();
              }
            }}
          />
          {selectedHost && (
            <div style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)", marginTop: "6px" }} className="truncate">
              ssh://{selectedHost.name}
              {remotePath.trim().replace(/\/+$/, "") || "/…"}
            </div>
          )}
        </div>

        <DialogFooter className="confirm-actions" style={{ marginTop: "16px" }}>
          <button className="confirm-btn" onClick={onClose}>{t("ssh.cancel")}</button>
          <button className="confirm-btn" onClick={connect} disabled={!selected || !remotePath.trim() || connecting}>
            {connecting ? t("ssh.connecting") : t("ssh.connect")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
