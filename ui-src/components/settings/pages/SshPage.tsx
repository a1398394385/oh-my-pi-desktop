// Settings · SSH hosts page: the user-scope ssh.json host table (same RPC
// surface as the welcome RemoteDialog: ssh_list_hosts / ssh_save_host /
// ssh_remove_host / ssh_test_host). Create & edit open the page-level editor
// window that replaces the page body (.set-edit-* head, same as skills/MCP/hooks)
// instead of expanding a row; rows reuse the clickable list-row language
// (.srow.mem-row + .mem-caret), never a modal. The probe (ssh_test_host) reports
// reachability plus remote OS/shell metadata.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, EditWindowHead } from "../common";

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

// One-line address label reused by the list row and the editor subtitle
const addrOf = (h: SshHostRow): string =>
  `${h.username ? `${h.username}@` : ""}${h.host}${h.port && h.port !== 22 ? `:${h.port}` : ""}`;

// Page-level editor window (create = host null / edit = the row being edited).
// Probe replies carry no correlation id beyond `name` (null for the inline probe),
// so the editor matches by the ts stamp the wsHandlers slice adds; only one editor
// is ever open, and the ref skips the in-flight wait.
function SshEditor({ host, onClose }: { host: SshHostRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const sshTestResult = useAppStore((s) => s.sshTestResult);
  const [form, setForm] = useState(() =>
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
  const [formError, setFormError] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const tsRef = useRef(0);
  const set = (k: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!sshTestResult || sshTestResult.ts === tsRef.current) return;
    tsRef.current = sshTestResult.ts;
    setTesting(false);
    if (sshTestResult.ok) {
      // testOk renders the value inside "Connected (…)"; meta rides in the same slot
      const meta = [sshTestResult.os, sshTestResult.shell].filter(Boolean).join(" · ");
      setResult({ ok: true, text: `${sshTestResult.latencyMs}ms${meta ? ` — ${meta}` : ""}` });
    } else {
      setResult({ ok: false, text: sshTestResult.error ?? "" });
    }
  }, [sshTestResult]);

  // The probe verdict describes the fields as tested; any edit invalidates it
  useEffect(() => {
    setFormError("");
  }, [form]);

  const test = () => {
    if (!form.host.trim()) {
      setFormError(t("ssh.nameAddressRequired"));
      return;
    }
    setTesting(true);
    setResult(null);
    send({ type: "ssh_test_host", host: form.host.trim(), username: form.username.trim(), port: form.port.trim(), keyPath: form.keyPath.trim() });
  };

  const save = () => {
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
    onClose();
  };

  const remove = async () => {
    if (!host) return;
    if (!(await confirmDialog({ title: t("ssh.deleteHost"), message: host.name, confirmText: t("common.delete"), danger: true }))) return;
    send({ type: "ssh_remove_host", name: host.name });
    onClose();
  };

  const status = testing
    ? t("ssh.testing")
    : result
      ? result.ok
        ? t("ssh.testOk", { ms: result.text })
        : `${t("ssh.testFail")}: ${result.text}`
      : "";

  return (
    <>
      <EditWindowHead
        title={host ? t("ssh.editHost") : t("ssh.newHost")}
        sub={host ? addrOf(host) : undefined}
        onBack={onClose}
      >
        {host ? (
          <button type="button" className="save-btn danger" onClick={remove}>
            {t("common.delete")}
          </button>
        ) : null}
        <button type="button" className="save-btn" disabled={testing} onClick={test}>
          {testing ? t("ssh.testing") : t("ssh.testBtn")}
        </button>
        <button type="button" className="save-btn" onClick={save}>
          {t("common.save")}
        </button>
      </EditWindowHead>
      <div className="set-card set-edit-card">
        <div className="ssh-form">
          <label className="ssh-field">
            <span>{t("ssh.nameLabel")} *</span>
            <input type="text" className="inp" placeholder={t("ssh.namePh")} spellCheck="false" value={form.name} onChange={set("name")} />
          </label>
          <label className="ssh-field">
            <span>{t("ssh.addressLabel")} *</span>
            <input type="text" className="inp" placeholder={t("ssh.addressPh")} spellCheck="false" value={form.host} onChange={set("host")} />
          </label>
          <div className="ssh-field-row">
            <label className="ssh-field">
              <span>{t("ssh.userLabel")}</span>
              <input type="text" className="inp" placeholder={t("ssh.userPh")} spellCheck="false" value={form.username} onChange={set("username")} />
            </label>
            <label className="ssh-field">
              <span>{t("ssh.portLabel")}</span>
              <input type="text" className="inp" placeholder={t("ssh.portPh")} spellCheck="false" value={form.port} onChange={set("port")} />
            </label>
          </div>
          <label className="ssh-field">
            <span>{t("ssh.keyPathLabel")}</span>
            <input type="text" className="inp" placeholder={t("ssh.keyPathPh")} spellCheck="false" value={form.keyPath} onChange={set("keyPath")} />
          </label>
          <label className="ssh-field">
            <span>{t("ssh.descLabel")}</span>
            <input type="text" className="inp" placeholder={t("ssh.descPh")} spellCheck="false" value={form.description} onChange={set("description")} />
          </label>
        </div>
        {formError ? <div className="ssh-form-err">{formError}</div> : null}
        {status ? (
          <div className="ssh-status-row">
            <span className="ssh-status" data-ok={result ? result.ok : undefined}>{status}</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

export default function SshPage() {
  const { t } = useTranslation();
  const hosts = useAppStore((s) => s.sshHosts);
  // Open editor window (replaces the page body): { host: null } = create, { host } = edit, null = list
  const [edit, setEdit] = useState<{ host: SshHostRow | null } | null>(null);

  useEffect(() => {
    send({ type: "ssh_list_hosts" });
  }, []);

  // Editor window replaces the whole page body
  if (edit) {
    return (
      <div className="set-page" id="pg-ssh">
        <SshEditor host={edit.host} onClose={() => setEdit(null)} />
      </div>
    );
  }

  return (
    <div className="set-page" id="pg-ssh">
      <div className="set-tt">{t("ssh.nav")}</div>
      <div className="set-group-tt ssh-head">
        <span>{t("ssh.hostSection")}</span>
        <button type="button" className="add-btn" onClick={() => setEdit({ host: null })}>
          <Icon name="plus" size={13} />
          {t("ssh.addHost")}
        </button>
      </div>
      <div className="set-card">
        {hosts.length === 0 ? (
          <div className="srow set-row">
            <div className="srow-tx">
              <span>{t("ssh.noHosts")}</span>
            </div>
          </div>
        ) : (
          hosts.map((h) => (
            <div key={h.name} className="srow mem-row" onClick={() => setEdit({ host: h })}>
              <div className="srow-tx">
                <b>{h.name}</b>
                <span>{addrOf(h)}</span>
                {h.description && <span>{h.description}</span>}
              </div>
              <div className="srow-ctl">
                <span className="mem-caret"><Icon name="caretSlim" size={14} /></span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
