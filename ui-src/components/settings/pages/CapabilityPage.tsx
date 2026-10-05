// Settings · Capability backends page: the five model-kind roles (web search / speech /
// dictation / judge / image) plus their engine API keys. Split out of the Model page on
// purpose — the provider grid there lists text-LLM vendors only, so non-chat runners
// (search engines, the TypeSafe judge backend) are configured here instead.
// Rows reuse the RolesView language (.srow.mp-role-row, hover disabled) and the provider
// detail key-input language (.pd-key-row + .inp + .save-btn).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { RolePicker, type CatalogModel, type ModelRole } from "../RolePicker";
import type { CapabilityKeyEntry } from "../../../types/frames";

// One kind-role row: name + tag + blurb on the left, the kind-filtered picker on the right
function CapabilityRoleRow({ role, allModels, desc }: { role: ModelRole; allModels: CatalogModel[]; desc: string }) {
  return (
    <div className="srow mp-role-row">
      <div className="srow-tx">
        <b>
          {role.name}
          {role.tag ? <span className="tag">{role.tag}</span> : null}
        </b>
        <span>{desc}</span>
      </div>
      <div className="srow-ctl">
        <RolePicker role={role} allModels={allModels} />
      </div>
    </div>
  );
}

// One engine key row: status + inline paste-and-save when unconfigured, tag + clear when a
// stored credential exists. Env-var-only configuration shows the tag without a clear button.
function KeyRow({ entry }: { entry: CapabilityKeyEntry }) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  // Any status flip (save/clear landed via the capability_keys push) resets the local input
  useEffect(() => {
    setKey("");
    setBusy(false);
  }, [entry.configured, entry.stored]);
  return (
    <div className="srow mp-role-row cap-key-row">
      <div className="srow-tx">
        <b>{entry.label}</b>
        <span>
          {entry.configured
            ? t("settingsPage.cap.keyConfigured")
            : t("settingsPage.cap.keyMissing", { env: entry.envVar })}
        </span>
      </div>
      <div className="srow-ctl">
        {entry.configured ? (
          <>
            <span className="tag">{t("settingsPage.cap.configured")}</span>
            {entry.stored ? (
              <button
                type="button"
                className="mp-role-clear"
                title={t("settingsPage.cap.clearKey")}
                onClick={() => {
                  setBusy(true);
                  send({ type: "provider_logout", provider: entry.id });
                }}
              >
                <Icon name="xmark" size={14} />
              </button>
            ) : null}
          </>
        ) : (
          <div className="pd-key-row">
            <input
              className={"inp" + (busy ? " disabled" : "")}
              type="password"
              placeholder={t("settingsPage.cap.keyPlaceholder")}
              value={key}
              disabled={busy}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              type="button"
              className={"save-btn" + (busy ? " busy" : "")}
              disabled={busy}
              onClick={() => {
                const k = key.trim();
                if (!k) {
                  toast(t("settingsPage.model.apiKeyMissing"));
                  return;
                }
                setBusy(true);
                send({ type: "provider_set_key", provider: entry.id, key: k });
              }}
            >
              {busy ? <Icon name="refresh" size={14} /> : t("common.save")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CapabilityPage() {
  const { t } = useTranslation();
  const allModels = useAppStore((s) => s.modelCatalog);
  const modelRoles = useAppStore((s) => s.modelRoles);
  const capabilityKeys = useAppStore((s) => s.capabilityKeys);
  const kindRoles = (modelRoles ?? []).filter((r) => r.section === "kind");
  const role = (id: string) => kindRoles.find((r) => r.id === id);
  const webKeys = (capabilityKeys ?? []).filter((k) => k.id !== "typesafe");
  const typesafeKey = (capabilityKeys ?? []).find((k) => k.id === "typesafe");
  return (
    <div className="set-page" id="pg-capabilities">
      <div className="set-tt">{t("settingsPage.nav.capabilities")}</div>
      <div className="set-group-desc">{t("settingsPage.cap.desc")}</div>

      {role("web") && (
        <div className="set-card">
          <div className="mp-head">
            <b>{t("settingsPage.cap.web.title")}</b>
            <span className="sp" />
            <span className="tag">{role("web")!.tag ?? "WEB"}</span>
          </div>
          <CapabilityRoleRow role={role("web")!} allModels={allModels} desc={t("settingsPage.cap.web.desc")} />
          <div className="mp-head">
            <b>{t("settingsPage.cap.keysTitle")}</b>
          </div>
          <div className="set-group-desc">{t("settingsPage.cap.keysDesc")}</div>
          {webKeys.map((k) => (
            <KeyRow entry={k} key={k.id} />
          ))}
          <SchemaRows sections={PAGE_PLACEMENT["pg-capabilities"]} />
        </div>
      )}

      {role("speech") && (
        <div className="set-card">
          <div className="mp-head">
            <b>{t("settingsPage.cap.speech.title")}</b>
            <span className="sp" />
            <span className="tag">{role("speech")!.tag ?? "SPEECH"}</span>
          </div>
          <CapabilityRoleRow role={role("speech")!} allModels={allModels} desc={t("settingsPage.cap.speech.desc")} />
        </div>
      )}

      {role("dictation") && (
        <div className="set-card">
          <div className="mp-head">
            <b>{t("settingsPage.cap.dictation.title")}</b>
            <span className="sp" />
            <span className="tag">{role("dictation")!.tag ?? "DICTATION"}</span>
          </div>
          <CapabilityRoleRow role={role("dictation")!} allModels={allModels} desc={t("settingsPage.cap.dictation.desc")} />
        </div>
      )}

      {role("judge") && (
        <div className="set-card">
          <div className="mp-head">
            <b>{t("settingsPage.cap.judge.title")}</b>
            <span className="sp" />
            <span className="tag">{role("judge")!.tag ?? "JUDGE"}</span>
          </div>
          <CapabilityRoleRow role={role("judge")!} allModels={allModels} desc={t("settingsPage.cap.judge.desc")} />
          {typesafeKey ? <KeyRow entry={typesafeKey} /> : null}
        </div>
      )}

      {role("image") && (
        <div className="set-card">
          <div className="mp-head">
            <b>{t("settingsPage.cap.image.title")}</b>
            <span className="sp" />
            <span className="tag">{role("image")!.tag ?? "IMAGE"}</span>
          </div>
          <CapabilityRoleRow role={role("image")!} allModels={allModels} desc={t("settingsPage.cap.image.desc")} />
        </div>
      )}
    </div>
  );
}
