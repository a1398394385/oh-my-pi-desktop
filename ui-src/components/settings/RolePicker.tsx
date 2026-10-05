// Role-specific picker shell over the shared configured-model selector
// (components/ModelPicker.tsx): candidate filtering mirrors the base's
// roleCandidatePool, value display and write-back stay role-specific. Consumed
// by the Model page's chat-role editor (RolesView) and the Capability backends
// page; the host re-validates on write via the role's accepts().
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppStore, send } from "../../store";
import { t } from "../../i18n";
import { ConfiguredModelPicker, type CatalogModel } from "../ModelPicker";

// Model role entry (modelRoles field)
export interface ModelRole {
  id: string;
  name: string;
  tag?: string | null; // host ModelRoleEntry is string | null
  value?: string | null; // unconfigured is null/absent
  section?: string; // "chat" | "kind" per the base's role metadata; kind roles live on the capability page
}

// Model kinds accepted per non-chat role (mirrors the base MODEL_ROLES accepts functions in
// pi-coding-agent config/model-roles.ts). Roles absent here (chat roles and user-defined custom
// roles) accept chat models only, matching the base getRoleInfo fallback.
const ROLE_KINDS: Record<string, string[]> = {
  tiny: ["tiny", "chat"],
  memory: ["tiny", "chat"],
  image: ["image"],
  // search backends, or chat models with web-search grounding (gated on the webSearch axis below)
  web: ["search", "chat"],
  speech: ["tts"],
  dictation: ["stt"],
  judge: ["judge", "tiny", "chat"],
};

// Whether a catalog model is a valid candidate for a role row's picker (same predicate as the
// base's roleCandidatePool filter; the host re-validates on write via the role's accepts())
export function roleAcceptsModel(role: ModelRole, m: CatalogModel): boolean {
  const kind = m.kind ?? "chat";
  if (!(ROLE_KINDS[role.id] ?? ["chat"]).includes(kind)) return false;
  return role.id !== "web" || kind !== "chat" || !!m.webSearch;
}

// Current value display of the role selector: unconfigured → "default"; exact catalog model hit → model name; otherwise (alias / level-suffixed) → raw value
export function roleSelLabel(role: ModelRole): string {
  if (!role.value) return role.id === "default" ? t("settingsPage.model.roleUnset") : t("settingsPage.model.roleDefault");
  const hit = useAppStore.getState().modelCatalog.find((m) => m.id === role.value);
  if (hit) return hit.name;
  return role.value;
}

/** Role row's picker: candidate filtering by the role's accepted kinds, value
 * display and write-back stay role-specific; the cascade interaction lives in
 * the shared ModelPicker core. */
export function RolePicker({ role }: { role: ModelRole }) {
  return (
    <ConfiguredModelPicker
      label={roleSelLabel(role)}
      selectedId={role.value ?? undefined}
      filter={(m) => roleAcceptsModel(role, m)}
      onPick={(value) => {
        if ((role.value ?? null) !== value) send({ type: "set_model_role", role: role.id, value });
      }}
    />
  );
}
