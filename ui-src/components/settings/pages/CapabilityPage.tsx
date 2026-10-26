// Settings · Special features page: the model-kind roles (web search /
// dictation / judge / image — the speech tts-model picker lives inside the
// voice output block, VoiceTtsSection) plus their engine API keys. Split out
// of the Model page on
// (search engines, the TypeSafe judge backend) are configured here instead.
// Page chrome follows the shared settings group idiom (.set-group-tt heading above one
// .set-card, same as the extensions/memory pages); rows use the canonical settings-card row
// language (.srow.set-row: standard geometry, row hover off, ctl right-aligned) and the
// engine keys reuse the provider-detail key-input language (.pd-key-row + .inp + .save-btn).
// Search-related schema settings render their own titled group via SchemaRows (kept outside
// the cards, never nested).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { RolePicker, roleSelLabel, type ModelRole } from "../RolePicker";
import type { CatalogModel } from "../../ModelPicker";
import { Sel, Srow } from "../common";
import { VoiceSttSection, VoiceTtsSection } from "./VoiceSection";
import type { CapabilityKeyEntry } from "../../../types/frames";

// Flat single-level picker for the WEB role: lists the usable search engines directly (no
// provider cascade). Usability comes from the host's search_availability frame — the base's
// explicit-availability predicate per engine (key configured / free public engine / local
// instance); until the reply lands, every search-kind model renders unfiltered. A current
// value that is not an available engine (e.g. a grounding chat model hand-set in settings)
// is appended so it stays visible and can be switched away from.
// The null id ("default" entry) maps to the empty string option value; onPick maps it back.
function WebSearchSel({ role, allModels }: { role: ModelRole; allModels: CatalogModel[] }) {
  const { t } = useTranslation();
  const availability = useAppStore((s) => s.searchAvailability);

  const engines = allModels.filter((m) => (m.kind ?? "chat") === "search" && (availability ? availability[m.id] !== false : true));
  const currentId = role.value ?? null;
  const current = currentId ? allModels.find((m) => m.id === currentId) : undefined;
  const items: { id: string | null; label: string }[] = [
    { id: null, label: t("settingsPage.model.roleDefault") },
    ...engines.map((m) => ({ id: m.id as string | null, label: m.name })),
  ];
  if (current && !engines.some((m) => m.id === current.id)) items.push({ id: current.id, label: current.name });

  const pick = (id: string | null) => {
    if ((role.value ?? null) !== id) send({ type: "set_model_role", role: role.id, value: id });
  };

  return (
    <Sel
      className="mp-role-sel"
      menuClassName="model mp-role-menu"
      label={roleSelLabel(role)}
      value={currentId ?? ""}
      options={items.map((it) => ({
        v: it.id ?? "",
        label: it.label,
        ck: currentId === it.id ? "✓" : "",
      }))}
      onPick={(v) => pick(v === "" ? null : v)}
    />
  );
}

// One kind-role row: name + tag + blurb on the left, the kind-filtered picker on the right.
// `picker` overrides the ctl content (the WEB row swaps in the flat WebSearchSel).
function CapabilityRoleRow({ role, desc, picker }: { role: ModelRole; desc: string; picker?: React.ReactNode }) {
  const allModels = useAppStore((s) => s.modelCatalog);
  return (
    <Srow
      title={
        <>
          {role.name}
          {role.tag ? <span className="tag">{role.tag}</span> : null}
        </>
      }
      desc={desc}
    >
      {picker ?? <RolePicker role={role} allModels={allModels} />}
    </Srow>
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
    <Srow
      title={entry.label}
      desc={
        entry.configured
          ? t("settingsPage.cap.keyConfigured")
          : t("settingsPage.cap.keyMissing", { env: entry.envVar })
      }
    >
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
    </Srow>
  );
}

// Group chrome shared by every capability block: heading (optional hover hint) + one card
function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <>
      <div className="set-group-tt">
        {title}
        {hint ? (
          <span className="gtt-hint" data-hint={hint}>
            <Icon name="info" size={14} />
          </span>
        ) : null}
      </div>
      <div className="set-card">{children}</div>
    </>
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
  const webRole = role("web");
  return (
    <div className="set-page" id="pg-capabilities">
      <div className="set-tt">{t("settingsPage.nav.capabilities")}</div>

      {webRole && (
        <Group title={t("settingsPage.cap.web.title")} hint={t("settingsPage.cap.keysDesc")}>
          <CapabilityRoleRow
            role={webRole}
            desc={t("settingsPage.cap.web.desc")}
            picker={<WebSearchSel role={webRole} allModels={allModels} />}
          />
          {webKeys.map((k) => (
            <KeyRow entry={k} key={k.id} />
          ))}
        </Group>
      )}

      <VoiceTtsSection />

      <VoiceSttSection />

      {role("judge") && (
        <Group title={t("settingsPage.cap.judge.title")}>
          <CapabilityRoleRow role={role("judge")!} desc={t("settingsPage.cap.judge.desc")} />
          {typesafeKey ? <KeyRow entry={typesafeKey} /> : null}
        </Group>
      )}

      {role("image") && (
        <Group title={t("settingsPage.cap.image.title")}>
          <CapabilityRoleRow role={role("image")!} desc={t("settingsPage.cap.image.desc")} />
        </Group>
      )}

      <SchemaRows sections={PAGE_PLACEMENT["pg-capabilities"]} />
    </div>
  );
}
