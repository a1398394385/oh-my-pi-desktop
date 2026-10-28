// Settings hub shared pieces: Promise-style confirm dialog, OMP login banner / paste-code
// dialog, empty-state row, provider icon map, and the shared row controls
// (Toggle / Sel / Srow — the .tg / .sel / .srow.set-row language of the old settings DOM).
// Ported from ui/settings/providers.js (confirmDialog / showLoginBanner / showLoginPrompt)
// and PROV_IC at the top of ui/settings/index.js; dialog DOM language (.lp-mask/.lp-box/
// .login-banner) is 1:1 with the old version.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { useAppStore, setBump, send, effZoom } from "../../store";
import { t } from "../../i18n";
import Icon from "../../Icon";
import { claimDropdown, releaseDropdown } from "../../lib/dropdownExclusive";

export { PROV_IC } from "../shared/models/providers";

// Props of the generic confirm dialog (all optional except title, all with defaults)
export interface ConfirmDialogProps {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
}

// Generic confirm dialog: reuses the login paste-code lp-mask/lp-box dialog language; the
// confirm button turns red on danger. Returns Promise<boolean>; clicking the mask or cancel
// resolves false (replaces native confirm, consistent look under WKWebView).
// Imperative API: each call mounts an independent React root on document.body and unmounts
// on close (equivalent of the old version's direct DOM mounting).
export function confirmDialog({ title, message = "", confirmText, danger = false }: ConfirmDialogProps): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    // Body sits outside the zoomed #settings subtree: carry the current zoom on
    // the host so the dialog matches the page (shortcut: zoom changes while the
    // dialog is open are not re-applied)
    (host.style as CSSStyleDeclaration & { zoom: string }).zoom = String(effZoom());
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (val: boolean) => {
      root.unmount();
      host.remove();
      resolve(val);
    };
    root.render(
      createElement("div", {
        className: "lp-mask",
        onClick: (e) => { if (e.target === e.currentTarget) done(false); },
      },
        createElement("div", { className: "lp-box" },
          createElement("div", { className: "lp-msg" }, title),
          message ? createElement("div", { className: "cf-msg" }, message) : null,
          createElement("div", { className: "lp-row" },
            createElement("button", { type: "button", className: "save-btn", onClick: () => done(false) }, t("common.cancel")),
            createElement("button", {
              type: "button",
              className: "save-btn" + (danger ? " danger" : ""),
              autoFocus: true,
              onClick: () => done(true),
            }, confirmText ?? t("common.confirm")),
          ),
        ),
      ),
    );
  });
}

// Bottom progress bar while login is in flight: status + cancel button (manual interrupt
// after closing the browser auth page).
// Data source: loginBanner selector (store handles login_progress / login_done replies; null = hidden).
export function LoginBanner() {
  const loginBanner = useAppStore((s) => s.loginBanner);
  if (loginBanner == null) return null;
  return (
    <div className="login-banner" id="loginBanner">
      <span>{loginBanner}</span>
      <button type="button" className="save-btn" onClick={() => send({ type: "provider_login_cancel" })}>
        {t("settingsPage.login.cancelLogin")}
      </button>
    </div>
  );
}

// Paste-code dialog of the login flow (host relays via login_prompt). Data source:
// loginPromptData selector ({ id, message, secret, reqId }); both confirm and cancel reply
// login_prompt_reply (empty string = cancel); mask click only closes the dialog — the host
// side still waits for input (old semantics preserved).
export function LoginPrompt() {
  const msg = useAppStore((s) => s.loginPromptData); // reply payload, shape see LoginPromptFrame
  const [text, setText] = useState("");
  // Clear the input on each new dialog (id change)
  useEffect(() => { setText(""); }, [msg?.id]);
  if (!msg) return null;
  const close = () => { setBump({ loginPromptData: null }); };
  const reply = (t: string) => {
    send({ type: "login_prompt_reply", id: msg.id, text: t });
    close();
  };
  return (
    <div
      className="lp-mask"
      id="loginPromptMask"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={(e) => { if (e.key === "Enter") reply(text); }}
    >
      <div className="lp-box">
        <div className="lp-msg">{msg.message || t("settingsPage.login.authPrompt")}</div>
        <input
          className="inp"
          type={msg.secret ? "password" : "text"}
          placeholder={t("settingsPage.login.authPlaceholder")}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
        <div className="lp-row">
          <button type="button" className="save-btn" onClick={() => reply(text)}>{t("common.confirm")}</button>
          <button type="button" className="save-btn" onClick={() => reply("")}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

// Empty-state row: loading and empty-data placeholder for settings card lists
// (agents / commands / hooks etc.).
// Default srow row shape (<div class="srow"><div class="srow-tx"><span>…); MCP / skills
// pages pass cls="mcp-empty-row" / "skill-empty-row" to override with the old empty-state classes.
export function emptyRow(text: string, cls?: string) {
  if (cls) return <div className={cls}><span>{text}</span></div>;
  return <div className="srow"><div className="srow-tx"><span>{text}</span></div></div>;
}

// ── Shared row controls (.tg switch / .sel dropdown / .srow.set-row row) ──
// One spelling for every settings page: the class names and DOM structure are
// 1:1 with the previously handwritten per-page copies.

// Pill switch (.tg): the bare-DOM equivalent of the handwritten
// {"tg" + (on ? " on" : "") + (disabled ? " disabled" : "")} markup.
export function Toggle({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <div className={"tg" + (on ? " on" : "") + (disabled ? " disabled" : "")} onClick={onChange}>
      <i></i>
    </div>
  );
}

// Shared dropdown mechanics: while open, claim the global dropdown slot
// (opening any dropdown closes the previous one — site-wide exclusivity via
// lib/dropdownExclusive) and close on any document click; the .sel container's
// stopPropagation keeps clicks inside the dropdown away from this listener.
// The close callback is kept in a ref so callers may pass an inline arrow
// without re-arming the listeners on every render.
export function useDropdownClose(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onClose = () => closeRef.current();
    claimDropdown(onClose);
    document.addEventListener("click", onClose);
    return () => {
      document.removeEventListener("click", onClose);
      releaseDropdown(onClose);
    };
  }, [open]);
}

// Dropdown option (1:1 with the old .mi; ck/note/disabled all optional)
export interface SelOption {
  v: string;
  label: ReactNode;
  /** Right-edge mark ("✓" on the current option; "" keeps the slot so the row's trailing edge does not shift) */
  ck?: string;
  /** Second line under the label (small, faint) — rendered only when present, so noteless options stay single-line */
  note?: string;
  /** Non-pickable row (.mi.disabled): grayed out with a ✕ in the check column */
  disabled?: boolean;
}

// Shared .sel container props (both modes below): variant classes and the
// legacy data-sel attribute carried by the old wireSel markup.
interface SelBaseProps {
  id?: string;
  className?: string;
  disabled?: boolean;
  /** Open the menu upward (rows where a downward menu would clip the viewport). */
  dropUp?: boolean;
  /** Wider menu for option labels that overflow the 170px base (device names). */
  wide?: boolean;
  /** Legacy data-sel attribute on the .sel container (old wireSel hook, kept 1:1). */
  dataSel?: string;
  /** Extra classes on the .menu (model / mp-role-menu / …). */
  menuClassName?: string;
}

// Options mode: text trigger + option list — the settings-pages Sel.
interface SelOptionsProps extends SelBaseProps {
  label: ReactNode;
  options: SelOption[];
  onPick: (v: string) => void;
  /** Current value: the matching option gets the .mi.on highlight (model-menu language). */
  value?: string | null;
}

// Children mode: arbitrary trigger button + arbitrary menu children, picking by
// delegation on the clicked .mi element (the McpPage generic dropdown). The
// callback is named onPickMi (not onPick) so the two modes' props never share a
// field with different signatures — that union would break contextual typing of
// the inline onPick lambdas at the call sites.
interface SelChildrenProps extends SelBaseProps {
  btnClassName?: string;
  btnTitle?: string;
  btnChildren?: ReactNode;
  menuId?: string;
  children?: ReactNode;
  onPickMi: (mi: HTMLElement) => void; // the picked .mi element
}

export type SelProps = SelOptionsProps | SelChildrenProps;

// Dropdown selector: the controlled .sel/.menu language of the old wireSel.
// Single implementation for every settings dropdown; the claim/click-close
// effect is shared via useDropdownClose so opening one dropdown closes the
// previous one and any outside click closes it. The menu stays mounted and is
// toggled with the .open class (.menu is display:none while closed — same
// visibility as the conditional-rendering variants it replaces).
export function Sel(props: SelProps) {
  const [open, setOpen] = useState(false);
  useDropdownClose(open, () => setOpen(false));
  const cls =
    "sel" +
    (props.disabled ? " disabled" : "") +
    (props.dropUp ? " sel-up" : "") +
    (props.wide ? " sel-wide" : "") +
    (props.className ? ` ${props.className}` : "");
  const menuCls = "menu" + (props.menuClassName ? ` ${props.menuClassName}` : "") + (open ? " open" : "");
  if ("children" in props) {
    const { btnClassName, btnTitle, btnChildren, menuId, children, onPickMi } = props as SelChildrenProps;
    return (
      <div
        className={cls}
        id={props.id}
        data-sel={props.dataSel}
        onClick={(e) => {
          if (props.disabled) return;
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <button type="button" className={btnClassName} title={btnTitle}>
          {btnChildren}
        </button>
        <div
          id={menuId}
          className={menuCls}
          onClick={(e) => {
            e.stopPropagation();
            const mi = (e.target as HTMLElement).closest(".mi") as HTMLElement | null;
            if (!mi || mi.classList.contains("disabled")) return;
            setOpen(false);
            onPickMi(mi);
          }}
        >
          {children}
        </div>
      </div>
    );
  }
  // The "children" check above only narrows the true branch (children is an
  // optional property), so the options branch reads through an explicit cast.
  const { label, options, onPick, value } = props as SelOptionsProps;
  return (
    <div
      className={cls}
      id={props.id}
      data-sel={props.dataSel}
      onClick={(e) => {
        if (props.disabled) return;
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {label} <Icon name="caret" size={14} className="caret-svg" />
      <div className={menuCls}>
        {options.map((o) => (
          <div
            key={o.v}
            className={
              "mi" +
              (o.disabled ? " disabled" : "") +
              (value != null && o.v === value ? " on" : "")
            }
            onClick={(e) => {
              e.stopPropagation();
              if (o.disabled) return;
              setOpen(false);
              onPick(o.v);
            }}
          >
            {/* Right column: ✕ for unavailable options, otherwise the checkmark (empty keeps the slot so the row's trailing edge does not shift) */}
            <span className="mi-ck">{o.disabled ? <Icon name="xmark" size={12} /> : o.ck}</span>
            <span className="mi-tx">
              <span className="mi-tt">{o.label}</span>
              {o.note && <span className="mi-note">{o.note}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Standard settings-card row (.srow.set-row): title + description on the left,
// right-aligned controls on the right; canonical row geometry with the row
// hover off. `title` takes the <b> content (may embed .tag chips), `desc` the
// <span> line, `children` the .srow-ctl content.
export function Srow({ title, desc, cls, dataKey, children }: {
  title: ReactNode;
  desc?: ReactNode;
  /** Extra row classes (e.g. " disabled"). */
  cls?: string;
  /** Settings-search scroll hook (data-key attribute). */
  dataKey?: string;
  children?: ReactNode;
}) {
  return (
    <div className={"srow set-row" + (cls ? ` ${cls}` : "")} data-key={dataKey}>
      <div className="srow-tx">
        <b>{title}</b>
        {desc != null && <span>{desc}</span>}
      </div>
      <div className="srow-ctl">{children}</div>
    </div>
  );
}

// ── Page-level asset editor window head (skills / MCP / hooks) ──
// Skills, MCP and hooks all fold their create & edit flows into one window that replaces
// the whole page body (same idea as the main-column automation editor): a back button, the
// title/subtitle block (subtitle carries the file path or source), and the right-aligned
// actions. The body is the page's own form card — <div className="set-card set-edit-card"> —
// so each page keeps its field language while the window chrome stays identical.
export function EditWindowHead({ title, sub, onBack, children }: {
  title: ReactNode;
  /** Second line under the title (path / source / hint); omitted when absent. */
  sub?: string;
  onBack: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="set-edit-head">
      <button type="button" className="icon-btn set-edit-back" title={t("settingsPage.shared.back")} onClick={onBack}>
        <span><Icon name="back" size={17} /></span>
      </button>
      <div className="set-edit-tt">
        <div className="set-edit-title">{title}</div>
        {sub ? <div className="set-edit-sub" title={sub}>{sub}</div> : null}
      </div>
      {children ? <div className="set-edit-actions">{children}</div> : null}
    </div>
  );
}

// ── Shared create/edit form row ──
// One labelled row of the shared form language (css/shared/form-layout.css): the label
// column carries the field name plus an optional short hint, the control column carries
// the inputs. Every create page (MCP, subagent, hook, skill, SSH) uses these rows so the
// forms read the same as the main-column automation editor.
export function FormRow({ label, hint, children }: {
  label: ReactNode;
  /** Short line under the label; omitted when absent. */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="frm-row">
      <div className="frm-label">
        <strong>{label}</strong>
        {hint ? <span className="frm-hint">{hint}</span> : null}
      </div>
      <div className="frm-ctl">{children}</div>
    </div>
  );
}
