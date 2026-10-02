// Settings · Model page (ported from ui/settings/models.js 419 lines + providers.js 289 lines):
// left column = model role entry + authenticated provider group list (credentials on top /
// models.yml config below);
// right card four views = provider detail (model enable/disable + quota + logout) /
// model roles (@role two-level cascading assignment) /
// add provider (card grid) / provider detail page (login / API key, either one).
// View switches and selections reuse store fields (mpAddView / mpRolesView / mpDetailProv /
// selectedProvider); login banner and paste-code dialog come from ../common.jsx.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, toast } from "../../../store";
import { t } from "../../../i18n";
import type { TimerHandle } from "../../../store";
import Icon from "../../../Icon";
import { PROV_IC, confirmDialog } from "../common";
import { fmtLimitWindow, limitTone } from "../../../lib/limits";
import type { LimitWindow } from "../../../lib/limits";
import type { AllProviderEntry } from "../../../types/frames";

// Catalog model entry (modelCatalog field, landed from the models_catalog reply; fields sent by host)
interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  context?: number | null;
  vision?: boolean;
  authSource?: string; // "cred" stored credential / "config" hand-written in models.yml
}

// Model role entry (modelRoles field)
interface ModelRole {
  id: string;
  name: string;
  tag?: string | null; // host ModelRoleEntry is string | null
  value?: string | null; // unconfigured is null/absent
}

// Provider quota result (providerLimits landed shape; accounts is the multi-account extension, field shape same as top level)
interface ProviderLimits {
  provider: string;
  label?: string;
  unsupported?: boolean;
  status?: string;
  windows: LimitWindow[];
  balance?: { amount?: number | null; currency?: string } | null;
  accounts?: Array<Partial<ProviderLimits> & { label?: string; accountLabel?: string }>;
}

// Purpose blurb keys for built-in roles (values are i18n keys; custom roles show a
// generic blurb; name/tag come from host-provided base metadata)
// Record rather than a literal union: RolesView indexes by arbitrary role.id
const ROLE_DESC_KEYS: Record<string, string> = {
  default: "settingsPage.model.roleDesc.default",
  smol: "settingsPage.model.roleDesc.smol",
  slow: "settingsPage.model.roleDesc.slow",
  vision: "settingsPage.model.roleDesc.vision",
  plan: "settingsPage.model.roleDesc.plan",
  commit: "settingsPage.model.roleDesc.commit",
  tiny: "settingsPage.model.roleDesc.tiny",
  task: "settingsPage.model.roleDesc.task",
  advisor: "settingsPage.model.roleDesc.advisor",
};

// One quota detail section (ui/ringpop.js buildLimitsSection ported to a component): semantics/colors use the shared definitions in lib/limits
function LimitsSection({ limits }: { limits: ProviderLimits }) {
  const { t } = useTranslation();
  let body: ReactNode;
  if (limits.unsupported) {
    body = t("settingsPage.model.quotaUnsupported");
  } else if (limits.status === "notConfigured") {
    body = t("settingsPage.model.quotaNotConfigured");
  } else if (!limits.windows?.length && !limits.balance) {
    body = t("settingsPage.model.quotaUnavailable");
  } else {
    // Balance-type providers (host-side synthesized metric:'credits' windows + balance) show only
    // the balance number, no progress bars or percentages; providers with percentage windows still render per window
    const pctWindows = limits.windows.filter((w) => w.metric !== "credits");
    if (!pctWindows.length && limits.balance?.amount != null) {
      body = (
        <div className="lx-bal">{t("settingsPage.model.quotaBalance", { amount: limits.balance.amount, currency: limits.balance.currency ?? "" })}</div>
      );
    } else if (!pctWindows.length) {
      body = t("settingsPage.model.quotaUnavailable");
    } else {
      body = (
        <>
          <div className="lx-grid">
            {pctWindows.slice(0, 4).map((w, i) => {
              const item = fmtLimitWindow(w);
              return (
                <div className="lx-col" key={i}>
                  <div className="lx-top"><span>{item.label}</span></div>
                  <div className="lx-mid" style={{ color: limitTone(item.remaining) }}>
                    {item.remaining != null ? `${item.remaining}%` : "—"}
                    {item.resetIn ? <span> · {item.resetIn}</span> : null}
                  </div>
                  <div className="lx-bar">
                    <i style={{ width: `${item.remaining != null ? Math.min(100, item.remaining) : 0}%`, background: limitTone(item.remaining) }} />
                  </div>
                </div>
              );
            })}
          </div>
          {limits.balance?.amount != null && (
            <div className="lx-bal">{t("settingsPage.model.quotaBalance", { amount: limits.balance.amount, currency: limits.balance.currency ?? "" })}</div>
          )}
        </>
      );
    }
  }
  return (
    <div className="cx-sec lx-sec">
      <div className="lx-head">
        <b>{t("settingsPage.model.quotaRemaining")}</b>
        <span className="lx-prov">{limits.label ?? ""}</span>
      </div>
      <div className="lx-body">{body}</div>
    </div>
  );
}

// Provider quota section: consumes providerLimits (provider_limits_result landed by store.js).
// Old stale-response guard ported: render data only when the provider matches; otherwise fall
// back to the "loading quota…" placeholder.
function QuotaSection({ provider }: { provider: string }) {
  const { t } = useTranslation();
  const lim = useAppStore((s) => s.providerLimits);
  if (!lim || lim.provider !== provider) {
    return <div className="mp-lim">{t("settingsPage.model.quotaLoading")}</div>;
  }
  // Multi-account: one section per account (account identity shown at the head's right); single account takes the original single-section path
  if (Array.isArray(lim.accounts) && lim.accounts.length > 1) {
    return (
      <div className="mp-lim">
        {lim.accounts.map((a, i) => (
          <LimitsSection key={i} limits={{ ...lim, ...a, label: a.label || a.accountLabel || t("settingsPage.model.accountN", { n: i + 1 }) }} />
        ))}
      </div>
    );
  }
  return (
    <div className="mp-lim">
      <LimitsSection limits={lim} />
    </div>
  );
}

// Current value display of the role selector: unconfigured → "default"; exact catalog model hit → model name; otherwise (alias / level-suffixed) → raw value
function roleSelLabel(role: ModelRole): string {
  if (!role.value) return role.id === "default" ? t("settingsPage.model.roleUnset") : t("settingsPage.model.roleDefault");
  const hit = useAppStore.getState().modelCatalog.find((m) => m.id === role.value);
  if (hit) return hit.name;
  return role.value;
}

// Model selector of a role row: two-level cascade (level-1 provider rows + hover right flyout),
// interaction aligned with the composer model menu
// (180ms hover-intent delay / 150ms grace close / flip left on right-edge overflow). The flyout
// is mounted under .sel rather than inside the level-1 menu —
// .menu.model carries overflow-y:auto which would clip absolutely positioned children. Widths
// unified by .mp-role-sel / .mp-role-menu.
function RolePicker({ role, allModels }: { role: ModelRole; allModels: CatalogModel[] }) {
  const [open, setOpen] = useState(false);
  const [flyProv, setFlyProv] = useState<string | null>(null); // provider of the current level-2 flyout
  const selRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>()); // prov -> provider row element (for flyout top alignment)
  const hideT = useRef<TimerHandle | undefined>(undefined); // flyout close grace
  const switchT = useRef<TimerHandle | undefined>(undefined); // row-switch hover-intent delay

  // Clear timers on unmount
  useEffect(() => () => { clearTimeout(hideT.current); clearTimeout(switchT.current); }, []);

  // Close on click outside the selector (global equivalent of the old closeAllMenus)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!selRef.current?.contains(e.target as Node | null)) {
        clearTimeout(hideT.current);
        clearTimeout(switchT.current);
        setOpen(false);
        setFlyProv(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Flyout coordinates: relative to .sel (offsetParent). The level-2 list opens upward —
  // bottom edge aligned with the provider row's bottom edge
  // (both menus pad 5px; +5 aligns the last row with the row height), so it never pushes past
  // the settings scroll area's bottom; when space above is insufficient, cap height + scroll
  // internally, top edge at most 4px below the settings scroll area's top; the flyout overlaps
  // the level-1 menu border by 4px and flips left on right-edge overflow.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const sel = selRef.current;
    const fly = flyRef.current;
    if (!menu || !sel || !fly || !flyProv) return;
    const row = rowRefs.current.get(flyProv);
    if (!row) return;
    const z = useAppStore.getState().zoomLevel || 1;
    fly.style.maxHeight = "";
    fly.style.overflowY = "";
    const rowBottom = menu.offsetTop + row.offsetTop - menu.scrollTop + row.offsetHeight;
    fly.style.top = "auto";
    fly.style.bottom = sel.clientHeight - rowBottom - 5 + "px";
    const bound = sel.closest("#setBody") ?? document.body;
    const boundRect = bound.getBoundingClientRect();
    const availAbove = Math.round((boundRect.top - 4) / z) + rowBottom + 5;
    if (fly.offsetHeight > availAbove) {
      fly.style.maxHeight = Math.max(80, availAbove) + "px";
      fly.style.overflowY = "auto";
    }
    fly.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px";
    if (fly.getBoundingClientRect().right > boundRect.right - 8) {
      fly.style.left = Math.max(0, menu.offsetLeft - fly.offsetWidth + 4) + "px";
    }
  }, [flyProv, open]);

  const pick = (value: string) => {
    if ((role.value ?? null) !== value) send({ type: "set_model_role", role: role.id, value });
    setOpen(false);
    setFlyProv(null);
  };

  const byProv = new Map<string, CatalogModel[]>();
  for (const m of allModels) {
    if (!byProv.has(m.provider)) byProv.set(m.provider, []);
    byProv.get(m.provider)!.push(m); // the has() on the previous line guarantees the group exists
  }

  return (
    <div
      className="sel mp-role-sel"
      role="button"
      ref={selRef}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
        if (open) setFlyProv(null);
      }}
    >
      <span>{roleSelLabel(role)}</span>
      <span className="caret-svg"><Icon name="caret" size={14} /></span>
      {open && (
        <div className="menu model mp-role-menu open" ref={menuRef}>
          {[...byProv].map(([prov, models]) => (
            <div
              className={"mi prov" + (prov === flyProv ? " on" : "")}
              key={prov}
              ref={(el) => { if (el) rowRefs.current.set(prov, el); else rowRefs.current.delete(prov); }}
              // 180ms hover-intent delay on row switch: don't steal focus when the pointer diagonally crosses middle rows toward the flyout
              onMouseEnter={() => {
                clearTimeout(hideT.current);
                if (prov === flyProv) return;
                clearTimeout(switchT.current);
                switchT.current = setTimeout(() => setFlyProv(prov), 180);
              }}
              onMouseLeave={() => clearTimeout(switchT.current)}
              onClick={(e) => {
                e.stopPropagation();
                clearTimeout(hideT.current);
                clearTimeout(switchT.current);
                setFlyProv(prov === flyProv ? null : prov);
              }}
            >
              {prov}
              <span className="sub"><Icon name="chevronRight" size={14} /></span>
            </div>
          ))}
        </div>
      )}
      {flyProv && (
        <div
          className="menu flyout open"
          ref={flyRef}
          onMouseEnter={() => { clearTimeout(hideT.current); clearTimeout(switchT.current); }}
          onMouseLeave={() => {
            clearTimeout(hideT.current);
            hideT.current = setTimeout(() => setFlyProv(null), 150);
          }}
        >
          {byProv.get(flyProv)!.map((m) => (
            <div className={"mi" + (role.value === m.id ? " on" : "")} key={m.id} onClick={(e) => { e.stopPropagation(); pick(m.id); }}>
              <span className="ck">{role.value === m.id ? "✓" : ""}</span>{m.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Right card: model roles view (srow rows + two-level cascading model selector + delete button for custom roles)
function RolesView() {
  const { t } = useTranslation();
  // Full catalog (including disabled models): role values may point at any catalog model; host validation and base resolution both use the full availableModels
  const allModels = useAppStore((s) => s.modelCatalog);
  const modelRoles = useAppStore((s) => s.modelRoles);
  return (
    <>
      <div className="mp-head">
        <b>{t("settingsPage.model.roleEntry")}</b>
        <span className="sp" />
        <span className="tag">{t("settingsPage.model.rolesCount", { count: modelRoles?.length ?? 0 })}</span>
      </div>
      <div className="set-group-desc mp-role-desc">{t("settingsPage.model.rolesDesc")}</div>
      {(modelRoles ?? []).map((role) => (
        <div className="srow mp-role-row" key={role.id}>
          <div className="srow-tx">
            <b>
              {role.name}
              {role.tag ? <span className="tag">{role.tag}</span> : null}
            </b>
            <span>
              {[
                t(ROLE_DESC_KEYS[role.id] ?? "settingsPage.model.roleCustom"),
                role.value && !allModels.some((m) => m.id === role.value) ? t("settingsPage.model.roleConfigValue", { value: role.value }) : null,
              ].filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="srow-ctl">
            <RolePicker role={role} allModels={allModels} />
            {/* Button column aligned with the delete button of custom rows: built-in roles get an X clear button (when set; = send null to revert to the inherited default),
                custom roles get a trash delete (.skill-trash-btn is the app-wide delete language; sending null = removed from modelRoles) */}
            {role.id in ROLE_DESC_KEYS ? (
              role.value ? (
                <button
                  type="button"
                  className="mp-role-clear"
                  title={t("settingsPage.model.clearRoleTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    send({ type: "set_model_role", role: role.id, value: null });
                  }}
                >
                  <Icon name="xmark" size={14} />
                </button>
              ) : null
            ) : (
              <button
                type="button"
                className="skill-trash-btn"
                title={t("settingsPage.model.deleteRoleTitle")}
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await confirmDialog({
                    title: t("settingsPage.model.deleteRoleConfirm", { name: role.name }),
                  });
                  if (ok) send({ type: "set_model_role", role: role.id, value: null });
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

// Start the OMP login flow (ported from ui/settings/providers.js startProviderLogin)
function startProviderLogin(id: string) {
  if (useAppStore.getState().loginBusy) {
    toast(t("settingsPage.model.loginBusy"));
    return;
  }
  const reqId = useAppStore.getState().loginReqId + 1;
  // Old showLoginBanner("…starting login…"); React version keeps banner data in store.loginBanner, rendered by the component
  setBump({ loginBusy: true, loginReqId: reqId, loginBanner: t("settingsPage.model.loginStarting", { id }) });
  send({ type: "provider_login", provider: id, reqId });
}

// "Add provider" view: two-column rounded cards in the right card, listing all supported
// providers (ported from renderAddProviderView).
// Pure render, no requests: credential counts are fetched explicitly via send get_all_providers
// at each view entry (sending here too would ping-pong with the
// all_providers response handler into infinite re-render).
// PROV_IC loosened locally to Record: the page indexes by arbitrary provider ids (the export in common.tsx stays untouched)
const provIc: Record<string, string> = PROV_IC;

// Same-family providers merged: the add list collapses each family into one card (title/note),
// the detail page blocks by member
// (block head id + region tag + method tag, method derived from the member's login). Key order
// of members is the block order; member ids not in allProvidersCache
// are silently skipped (the UI list source grows and shrinks with the base).
// note holds an i18n key (brand-family blurb, bilingual); resolved via t() at render.
const PROVIDER_FAMILIES: Record<string, { title: string; note: string; members: Record<string, string> }> = {
  zai: {
    title: "Z.AI",
    note: "settingsPage.model.familyZhipu",
    members: { zai: "Global", "zai-coding-plan": "Global", "zhipu-coding-plan": "China" },
  },
  minimax: {
    title: "MiniMax",
    note: "settingsPage.model.familyMinimax",
    members: {
      "minimax-code": "International",
      "minimax-code-cn": "China",
      minimax: "International",
      "minimax-cn": "China",
    },
  },
  xiaomi: {
    title: "Xiaomi",
    note: "settingsPage.model.familyXiaomi",
    members: {
      xiaomi: "Global",
      "xiaomi-token-plan-cn": "China",
      "xiaomi-token-plan-sgp": "Singapore",
      "xiaomi-token-plan-ams": "Europe",
    },
  },
  xai: {
    title: "xAI",
    note: "settingsPage.model.familyXai",
    members: { "xai-oauth": "Subscription", xai: "Pay-as-you-go" },
  },
  moonshot: {
    title: "Moonshot",
    note: "settingsPage.model.familyMoonshot",
    members: { "kimi-code": "Subscription", moonshot: "Pay-as-you-go" },
  },
  alibaba: {
    title: "Alibaba",
    note: "settingsPage.model.familyAlibaba",
    members: { "alibaba-coding-plan": "Coding Plan", "alibaba-token-plan": "Token Plan" },
  },
};

// Reverse lookup: provider id -> family id (providers in no family are laid out flat)
const FAMILY_OF: Record<string, string> = {};
for (const [fid, fam] of Object.entries(PROVIDER_FAMILIES)) {
  for (const id of Object.keys(fam.members)) FAMILY_OF[id] = fid;
}
function AddProviderView() {
  const { t } = useTranslation();
  const allProvidersCache = useAppStore((s) => s.allProvidersCache);
  // Flat sequence + family folding: family members collapse into the family card (position = first member's original slot, member order = FAMILIES definition order)
  type Row =
    | { kind: "plain"; p: AllProviderEntry }
    | { kind: "family"; fid: string; members: AllProviderEntry[] };
  const rows: Row[] = [];
  const famIndex = new Map<string, number>();
  if (allProvidersCache) {
    for (const p of allProvidersCache) {
      const fid = FAMILY_OF[p.id];
      if (!fid) {
        rows.push({ kind: "plain", p });
        continue;
      }
      const at = famIndex.get(fid);
      if (at === undefined) {
        famIndex.set(fid, rows.length);
        rows.push({ kind: "family", fid, members: [p] });
      } else if (rows[at].kind === "family") {
        rows[at].members.push(p);
      }
    }
    for (const row of rows) {
      if (row.kind !== "family") continue;
      row.members.sort(
        (a, b) =>
          Object.keys(PROVIDER_FAMILIES[row.fid].members).indexOf(a.id) -
          Object.keys(PROVIDER_FAMILIES[row.fid].members).indexOf(b.id),
      );
    }
  }
  return (
    <>
      <div className="mp-head"><b>{t("settingsPage.model.addViewTitle")}</b></div>
      <div className="set-group-desc">{t("settingsPage.model.addViewDesc")}</div>
      {allProvidersCache == null ? (
        <div className="set-group-desc">{t("settingsPage.model.loading")}</div>
      ) : (
        <div className="ap-grid">
          {rows.map((row) =>
            row.kind === "plain" ? (
              <div className="ap-card ap-card2" key={row.p.id} onClick={() => { setBump({ mpDetailProv: row.p }); }}>
                <div className="ap-l1">
                  <span className="pv-ic">{provIc[row.p.id] || "✦"}</span>
                  <span className="flex-1 min-w-0 truncate text-ui-base text-text">{row.p.id}</span>
                </div>
                <div className="ap-l2">
                  <span className="tag ap-vendor">{row.p.label}</span>
                  {row.p.accounts > 0 ? <span className="flex-none ml-auto text-ui-xs text-green">{t("settingsPage.model.configured", { count: row.p.accounts })}</span> : null}
                </div>
              </div>
            ) : (
              (() => {
                const fam = PROVIDER_FAMILIES[row.fid];
                const accounts = row.members.reduce((n, m) => n + (m.accounts || 0), 0);
                return (
                  <div
                    className="ap-card ap-card2"
                    key={row.fid}
                    onClick={() => {
                      // Family card synthesizes an entry: id is the family id (the detail page enters family mode on it)
                      setBump({ mpDetailProv: { ...row.members[0], id: row.fid, label: fam.note } });
                    }}
                  >
                    <div className="ap-l1">
                      <span className="pv-ic">{provIc[row.fid] || provIc[row.members[0].id] || "✦"}</span>
                      <span className="flex-1 min-w-0 truncate text-ui-base text-text">{fam.title}</span>
                    </div>
                    <div className="ap-l2">
                      <span className="tag ap-vendor">{t(fam.note)}</span>
                      {accounts > 0 ? <span className="flex-none ml-auto text-ui-xs text-green">{t("settingsPage.model.configured", { count: accounts })}</span> : null}
                    </div>
                  </div>
                );
              })()
            ),
          )}
          {/* Trailing fixed card: manual add = config-layer models.yml */}
          <div
            className="ap-card ap-card2"
            onClick={() => {
              send({ type: "open_models_config" });
              toast(t("settingsPage.model.manualAddToast"));
            }}
          >
            <div className="ap-l1">
              <span className="pv-ic">✎</span>
              <span className="flex-1 min-w-0 truncate text-ui-base text-text">{t("settingsPage.model.manualAdd")}</span>
            </div>
            <div className="ap-l2">
              <span className="tag ap-vendor">models.yml</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Member block: either a login card or an API key input (method derived from prov.login).
// grouped = family mode: render the block head (id + region + method tag); single-provider
// mode keeps the full-page layout.
// API key only for non-login providers: login-type (oauth/device/custom) credentials belong to
// the catalog provider via browser auth (store-as); the catalog has no same-name provider, so
// pasting a key would only create an orphan credential that can never be used
function MemberBlock({ prov, region, grouped }: { prov: AllProviderEntry; region?: string; grouped?: boolean }) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false); // save in flight: input dimmed, button spins until the provider_key_done reply switches this view back to the list
  return (
    <div className="pd-member">
      {grouped ? (
        <div className="pd-member-head">
          <b>{prov.id}</b>
          {region ? <span className="tag">{region}</span> : null}
          <span className="tag">{prov.login ? "Sign in" : "API Key"}</span>
        </div>
      ) : null}
      {prov.login ? (
        <>
          <div className="ap-card pd-login" onClick={() => startProviderLogin(prov.id)}>
            <span className="pv-ic">🌐</span>
            <span className="flex-1 min-w-0 truncate text-ui-base text-text">{t("settingsPage.model.signIn")}</span>
            <span className="tag">{t("settingsPage.model.browserAuth")}</span>
          </div>
          {!grouped ? (
            <div className="set-group-desc">
              {t("settingsPage.model.loginOnlyDesc")}
            </div>
          ) : null}
        </>
      ) : (
        <div className="pd-key">
          <div className="srow-tx">
            <b>API Key</b>
            <span>{t("settingsPage.model.apiKeyDesc")}</span>
          </div>
          <div className="pd-key-row">
            <input
              className={"inp" + (saving ? " disabled" : "")}
              type="password"
              placeholder="sk-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              type="button"
              className={"save-btn" + (saving ? " busy" : "")}
              disabled={saving}
              onClick={() => {
                const k = key.trim();
                if (!k) {
                  toast(t("settingsPage.model.apiKeyMissing"));
                  return;
                }
                setSaving(true);
                send({ type: "provider_set_key", provider: prov.id, key: k });
              }}
            >
              {saving ? <Icon name="refresh" size={14} /> : t("common.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Provider detail page: one block per single provider; entering from a family card blocks by FAMILIES member order (only members actually present in the list are rendered)
function ProviderDetailView() {
  const { t } = useTranslation();
  const p = useAppStore((s) => s.mpDetailProv);
  const allProvidersCache = useAppStore((s) => s.allProvidersCache);
  if (!p) return null;
  const fam = PROVIDER_FAMILIES[p.id];
  const members = fam
    ? Object.entries(fam.members).map(([id, region]) => ({
        // Fallback synthesis when a member is not in allProvidersCache (e.g. minimax-cn has no
        // OAuth/VENDOR entry): the base bundled catalog still supports the provider — pasting a
        // key just works (no login flow, no credential)
        prov: allProvidersCache?.find((x) => x.id === id) ?? { id, label: "", login: false, accounts: 0 },
        region,
      }))
    : [{ prov: p, region: undefined }];
  return (
    <>
      <div className="mp-head">
        <button
          type="button"
          className="save-btn"
          onClick={() => {
            setBump({ mpDetailProv: null });
            // Refetch credential counts when returning to the list: a login/logout may have just happened on the detail page
            send({ type: "get_all_providers" });
          }}
        >
          {t("settingsPage.model.back")}
        </button>
        <b>{(provIc[members[0].prov.id] || "✦") + " " + (fam ? fam.title : p.id)}</b>
        <span className="tag">{fam ? t(fam.note) : p.label}</span>
      </div>
      {members.map((m, i) => (
        <Fragment key={m.prov.id}>
          {fam && i > 0 ? <div className="pd-div" /> : null}
          <MemberBlock prov={m.prov} region={m.region} grouped={!!fam} />
        </Fragment>
      ))}
    </>
  );
}

// Right card: selected provider detail (model enable/disable + quota + logout)
function ProviderModelsView({ prov, models }: { prov: string; models: CatalogModel[] }) {
  const { t } = useTranslation();
  const anyOn = models.some((m) => m.enabled);
  const logout = async () => {
    const ok = await confirmDialog({
      title: t("settingsPage.model.logoutConfirmTitle", { provider: prov }),
      message: t("settingsPage.model.logoutConfirmMsg"),
      confirmText: t("settingsPage.model.logout"),
      danger: true,
    });
    if (!ok) return;
    send({ type: "provider_logout", provider: prov });
    toast(t("settingsPage.model.loggingOut"));
  };
  return (
    <>
      <div className="mp-head">
        <b>{(provIc[prov] || "✦") + " " + prov}</b>
        <span className="sp" />
        <span className="tag">{t("settingsPage.model.modelsCount", { count: models.length })}</span>
        {/* Credential-type providers offer logout (multi-account logs out all credentials at once, same as CLI auth-broker logout);
            config-type (models.yml hand-written apiKey) takes priority over stored credentials, deleting credentials is ineffective, so no button */}
        {models[0]?.authSource === "cred" ? (
          <button type="button" className="save-btn danger" onClick={logout}>{t("settingsPage.model.logout")}</button>
        ) : null}
      </div>
      {/* Provider quota: hits the host-side 60s cache; switching providers re-queries (send see ModelPage effect) */}
      <QuotaSection provider={prov} />
      <div className="mp-ml"><span>{t("settingsPage.model.modelList")}</span></div>
      {models.map((m) => (
        <div className="mp-row" key={m.id}>
          <span>{m.name}</span>
          {/* Context formatted as decimal vendor nominal: 1000000 → 1M, 1310720 → 1.3M, 200000 → 200k.
              No 1024-base conversion — catalog values are decimal nominals; 1000000 would compute as 977k */}
          {m.context ? (
            <span className="tag">
              {m.context >= 1000000
                ? (Math.round(m.context / 100000) / 10).toString().replace(/\.0$/, "") + "M"
                : m.context >= 1000
                  ? Math.round(m.context / 1000) + "k"
                  : String(m.context)}
            </span>
          ) : null}
          {m.vision ? <span className="tag">{t("settingsPage.model.visionTag")}</span> : null}
          <span className="sp" />
          <div
            className={"tg" + (m.enabled ? " on" : "")}
            onClick={() => {
              if (m.enabled && useAppStore.getState().modelCatalog.filter((x) => x.enabled).length <= 1) {
                toast(t("settingsPage.model.keepOneModel"));
                return;
              }
              send({ type: "set_enabled_model", id: m.id, enabled: !m.enabled });
            }}
          >
            <i />
          </div>
        </div>
      ))}
      {!anyOn ? (
        <div className="set-group-desc" style={{ marginTop: "8px" }}>{t("settingsPage.model.noEnabledModels")}</div>
      ) : null}
    </>
  );
}

export default function ModelPage() {
  const { t } = useTranslation();
  const modelCatalog = useAppStore((s) => s.modelCatalog);
  const mpAddView = useAppStore((s) => s.mpAddView);
  const mpRolesView = useAppStore((s) => s.mpRolesView);
  const mpDetailProv = useAppStore((s) => s.mpDetailProv);
  let selectedProvider = useAppStore((s) => s.selectedProvider);
  // Left-column grouping: provider -> models (modelCatalog, landed from the models_catalog reply)
  const groups = new Map<string, CatalogModel[]>();
  for (const m of modelCatalog) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider)!.push(m);
  }
  // Selection fallback: not in roles view and nothing selected / the selected provider is no
  // longer in the catalog — take the first group
  // (silent store write during render, same old S-write semantics without bump; condition converges, cannot retrigger)
  if (!mpRolesView && (!selectedProvider || !groups.has(selectedProvider))) {
    selectedProvider = groups.keys().next().value ?? null;
    useAppStore.setState({ selectedProvider });
  }
  // Grouping: login/API key credentials on top, models.yml config below, with a divider + group label between
  const credEntries: Array<[string, CatalogModel[]]> = [];
  const configEntries: Array<[string, CatalogModel[]]> = [];
  for (const entry of groups) {
    (entry[1][0]?.authSource === "config" ? configEntries : credEntries).push(entry);
  }
  const sel = selectedProvider;
  const models = (sel ? groups.get(sel) : undefined) || []; // sel null yields undefined → [], equivalent
  const showProvDetail = !mpAddView && !mpRolesView && groups.size > 0;
  // Provider quota: hits the host-side 60s cache; re-query on entering detail / switching provider
  useEffect(() => {
    if (showProvDetail && sel) send({ type: "get_provider_limits", provider: sel });
  }, [showProvDetail, sel]);

  return (
    <div className="set-page" id="pg-model">
      <div className="set-tt">{t("settingsPage.nav.model")}</div>
      <div className="set-desc-row">
        <span className="text-ui-sm text-faint">{t("settingsPage.model.desc")}</span>
        <span className="sp" />
        <button
          type="button"
          className="icon-btn pg-refresh"
          title={t("settingsPage.model.refresh")}
          onClick={() => {
            send({ type: "reload_settings" });
            send({ type: "get_models_catalog" });
          }}
        >
          <Icon name="refresh" size={17} />
        </button>
        <button
          className="add-btn"
          type="button"
          onClick={() => {
            setBump({ mpAddView: true, mpRolesView: false });
            // Fetch latest credential counts when entering the add view so the "configured" display converges right after logout
            send({ type: "get_all_providers" });
          }}
        >
          {t("settingsPage.model.addProvider")}
        </button>
      </div>
      <div className="set-card mp">
        <div className="mp-l">
          {/* Model role entry: global @role → model assignment, placed above the provider list */}
          <div
            className={"pv" + (mpRolesView ? " on" : "")}
            onClick={() => {
              setBump({ mpAddView: false, mpRolesView: true });
              send({ type: "get_model_roles" });
            }}
          >
            <span className="pv-ic"><Icon name="sliders" size={14} /></span>
            <span className="flex-1 min-w-0 truncate font-semibold">{t("settingsPage.model.roleEntry")}</span>
          </div>
          <div className="pd-div mp-div" />
          <div className="set-sec mp-grp">{t("settingsPage.model.groupAuthenticated")}</div>
          {credEntries.map(([prov, ms]) => (
            <div
              className={"pv" + (!mpRolesView && prov === sel ? " on" : "")}
              key={prov}
              onClick={() => {
                setBump({ mpAddView: false, mpRolesView: false, selectedProvider: prov });
              }}
            >
              <span className="pv-ic">{provIc[prov] || "✦"}</span>
              <span className="flex-1 min-w-0 truncate font-semibold">{prov}</span>
              {ms.some((m) => m.enabled) ? <span className="dot" /> : null}
            </div>
          ))}
          {credEntries.length > 0 && configEntries.length > 0 ? <div className="pd-div mp-div" /> : null}
          {configEntries.length > 0 ? <div className="set-sec mp-grp">{t("settingsPage.model.groupConfigFile")}</div> : null}
          {configEntries.map(([prov, ms]) => (
            <div
              className={"pv" + (!mpRolesView && prov === sel ? " on" : "")}
              key={prov}
              onClick={() => {
                setBump({ mpAddView: false, mpRolesView: false, selectedProvider: prov });
              }}
            >
              <span className="pv-ic">{provIc[prov] || "✦"}</span>
              <span className="flex-1 min-w-0 truncate font-semibold">{prov}</span>
              {ms.some((m) => m.enabled) ? <span className="dot" /> : null}
            </div>
          ))}
          {groups.size === 0 ? (
            <div className="pv">{t("settingsPage.model.noModels")}</div>
          ) : null}
        </div>
        <div className="mp-r">
          {mpAddView ? (
            mpDetailProv ? <ProviderDetailView /> : <AddProviderView />
          ) : mpRolesView ? (
            <RolesView />
          ) : showProvDetail ? (
            // sel is guaranteed chosen under protocol data (this branch exists only when groups is non-empty), the ! assertion passes it through like the original
            <ProviderModelsView prov={sel!} models={models} />
          ) : (
            <div className="set-group-desc">
              {groups.size === 0 ? t("settingsPage.model.noHost") : t("settingsPage.model.pickProvider")}
            </div>
          )}
        </div>
      </div>
      {/* Login-in-progress banner + paste-code dialog hoisted to the Settings shell root (common.jsx); page switches don't interrupt login */}
    </div>
  );
}
