// Settings · Shell page: Bash group, the bash-interceptor card (enabled toggle +
// graphical rules editor for the fixed-structure JSON array bashInterceptor.patterns),
// the shell-minimizer group, then eval & runtimes. The interceptor section carries an
// id in PAGE_PLACEMENT (skipped by SchemaRows) — this page lays it out so the toggle
// and the rule list share one card. Rule rows follow the memory-page row language
// (.srow + .on highlight + .mem-caret); the edit form reuses the MCP editor classes
// (.mem-expand / .sem-body.form / .mcp-form-*).
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows, { SchemaRowsBare, SchemaGroupTitle } from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { confirmDialog, emptyRow } from "../common";

const RULES_KEY = "bashInterceptor.patterns";

// One bash-interceptor rule — fixed structure owned by the base (exec/settings.ts):
// commands matching the `pattern` regex are blocked and the agent is told to use
// `tool` instead (message). The index signature preserves unknown extra fields
// (e.g. allowSubcommands) through a graphical edit.
interface InterceptorRule {
  pattern: string;
  flags?: string;
  tool: string;
  message: string;
  [extra: string]: unknown;
}

// ---------- Inline expand-down rule editor (same pattern as the MCP editor) ----------

interface RuleEditorProps {
  initial: InterceptorRule;
  // null index = creating; the editor head hides the move buttons
  index: number | null;
  total: number;
  onSave: (rule: InterceptorRule) => void;
  onClose: () => void;
  onMove?: (dir: -1 | 1) => void;
  onDelete?: () => void;
}

function RuleEditor({ initial, index, total, onSave, onClose, onMove, onDelete }: RuleEditorProps) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState(initial.pattern);
  const [flags, setFlags] = useState(typeof initial.flags === "string" ? initial.flags : "");
  const [tool, setTool] = useState(initial.tool);
  const [message, setMessage] = useState(initial.message);

  const save = () => {
    const p = pattern.trim();
    const f = flags.trim();
    const tl = tool.trim();
    const m = message.trim();
    if (!p || !tl || !m) {
      toast(t("settingsPage.shellPage.ruleRequired"));
      return;
    }
    try {
      new RegExp(p, f || undefined);
    } catch (err) {
      toast(t("settingsPage.shellPage.regexInvalid", { err: err instanceof Error ? err.message : String(err) }));
      return;
    }
    // Spread-then-override keeps unknown extra fields of the edited rule intact
    onSave({ ...initial, pattern: p, flags: f || undefined, tool: tl, message: m });
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    if (await confirmDialog({ title: t("settingsPage.shellPage.ruleDeleteConfirm"), confirmText: t("common.delete"), danger: true })) {
      onDelete();
    }
  };

  const sp = <span className="sp" />;
  return (
    <div className="mem-expand">
      <div className="mem-exp-head">
        <span>{index === null ? t("settingsPage.shellPage.ruleNewTitle") : t("settingsPage.shellPage.ruleEditTitle", { index: index + 1 })}</span>
        {sp}
        {onMove && index !== null && index > 0 && (
          <button type="button" className="save-btn" title={t("settingsPage.shellPage.moveUp")} onClick={() => onMove(-1)}>
            <Icon name="arrowUp" size={12} />
          </button>
        )}
        {onMove && index !== null && index < total - 1 && (
          <button type="button" className="save-btn itcp-flip" title={t("settingsPage.shellPage.moveDown")} onClick={() => onMove(1)}>
            <Icon name="arrowUp" size={12} />
          </button>
        )}
        <button type="button" className="save-btn" onClick={onClose}>
          {t("settingsPage.shared.collapse")}
        </button>
      </div>
      <div className="sem-body form">
        <div className="mcp-form-row">
          <div className="mcp-form-group itcp-form-pattern">
            <label className="mcp-form-label">{t("settingsPage.shellPage.patternLabel")} <span className="req">*</span></label>
            <textarea
              className="mcp-form-textarea mcp-form-code"
              rows={2}
              spellCheck={false}
              value={pattern}
              placeholder={t("settingsPage.shellPage.patternPlaceholder")}
              onChange={(e) => setPattern(e.target.value)}
            />
          </div>
          <div className="mcp-form-group mcp-form-half">
            <label className="mcp-form-label">{t("settingsPage.shellPage.toolLabel")} <span className="req">*</span></label>
            <input
              type="text"
              className="mcp-form-input mcp-form-code"
              spellCheck={false}
              value={tool}
              placeholder={t("settingsPage.shellPage.toolPlaceholder")}
              onChange={(e) => setTool(e.target.value)}
            />
          </div>
        </div>
        <div className="mcp-form-group">
          <label className="mcp-form-label">{t("settingsPage.shellPage.messageLabel")} <span className="req">*</span></label>
          <textarea
            className="mcp-form-textarea"
            rows={2}
            spellCheck={false}
            value={message}
            placeholder={t("settingsPage.shellPage.messagePlaceholder")}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <div className="mcp-form-group">
          <label className="mcp-form-label">{t("settingsPage.shellPage.flagsLabel")}</label>
          <input
            type="text"
            className="mcp-form-input mcp-form-code"
            spellCheck={false}
            value={flags}
            placeholder={t("settingsPage.shellPage.flagsPlaceholder")}
            onChange={(e) => setFlags(e.target.value)}
          />
          <div className="mcp-form-hint">{t("settingsPage.shellPage.flagsHint")}</div>
        </div>
        <div className="sem-foot">
          {onDelete && (
            <button type="button" className="mcp-form-del" onClick={confirmDelete}>
              <Icon name="trash" size={13} />
              {t("common.delete")}
            </button>
          )}
          {sp}
          <button type="button" className="mcp-form-cancel" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="confirm-btn" onClick={save}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Rules list ----------

function InterceptorRules() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  // Layered value from the host snapshot: the default ruleset when unset
  const rules: InterceptorRule[] | null = hostSettings
    ? (Array.isArray(hostSettings.values?.[RULES_KEY]) ? (hostSettings.values![RULES_KEY] as InterceptorRule[]) : [])
    : null;
  // Expanded rule tracked by object identity: a save replaces the object (editor
  // auto-closes), a move keeps it (editor follows the rule to its new position)
  const [openRule, setOpenRule] = useState<InterceptorRule | null>(null);
  const [creating, setCreating] = useState(false);

  const saveRules = (next: InterceptorRule[]) => send({ type: "set_setting", key: RULES_KEY, value: next });

  const move = (rule: InterceptorRule, dir: -1 | 1) => {
    const i = rules!.indexOf(rule);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rules!.length) return;
    const next = rules!.slice();
    [next[i], next[j]] = [next[j], next[i]];
    saveRules(next);
  };

  const head = (
    <div className="srow itcp-head" data-key={RULES_KEY}>
      <div className="srow-tx">
        <b>{t("settingsPage.shellPage.rulesLabel")}</b>
        <span>{t("settingsPage.shellPage.rulesHint")}</span>
      </div>
      <div className="srow-ctl">
        {rules && <span className="tag">{t("settingsPage.shellPage.rulesCount", { count: rules.length })}</span>}
        <button type="button" className="add-btn" onClick={() => setCreating((v) => !v)}>
          {t("settingsPage.shellPage.addRule")}
        </button>
      </div>
    </div>
  );

  if (!rules) return <>{head}{emptyRow(t("common.loading"))}</>;
  if (rules.length === 0 && !creating) return <>{head}{emptyRow(t("settingsPage.shellPage.rulesEmpty"))}</>;

  return (
    <>
      {head}
      {creating && (
        <RuleEditor
          initial={{ pattern: "", tool: "", message: "" }}
          index={null}
          total={rules.length}
          onClose={() => setCreating(false)}
          // New rules append last so they never shadow the earlier ones
          onSave={(rule) => {
            saveRules([...rules, rule]);
            setCreating(false);
          }}
        />
      )}
      {rules.map((r, i) => (
        <Fragment key={i}>
          <div className={"srow itcp-row" + (openRule === r ? " on" : "")} onClick={() => setOpenRule(openRule === r ? null : r)}>
            <div className="srow-tx">
              <b>
                <span className="tag">{typeof r.tool === "string" ? r.tool : "?"}</span>
                {typeof r.flags === "string" && r.flags ? <span className="itcp-flags">/{r.flags}</span> : null}
              </b>
              <span className="itcp-pattern">{r.pattern}</span>
            </div>
            <span className="mem-caret">
              <Icon name="caretSlim" size={14} />
            </span>
          </div>
          {openRule === r && (
            <RuleEditor
              initial={r}
              index={i}
              total={rules.length}
              onClose={() => setOpenRule(null)}
              onSave={(rule) => {
                saveRules(rules.map((x) => (x === r ? rule : x)));
                setOpenRule(null);
              }}
              onMove={(dir) => move(r, dir)}
              onDelete={() => {
                saveRules(rules.filter((x) => x !== r));
                setOpenRule(null);
              }}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}

// ---------- Page ----------

// The interceptor section carries an id so SchemaRows skips it; this page lays it out at
// its placement position (found by id — surrounding sections may grow or reorder)
export default function ShellPage() {
  const sections = PAGE_PLACEMENT["pg-shell"];
  const interceptorIdx = sections.findIndex((s) => s.id === "bashInterceptor");
  const interceptor = sections[interceptorIdx];
  return (
    <div className="set-page" id="pg-shell">
      <div className="set-tt">Shell</div>
      <SchemaRows sections={sections.slice(0, interceptorIdx)} />
      <SchemaGroupTitle sections={[interceptor]} />
      <div className="set-card">
        <SchemaRowsBare sections={[interceptor]} />
        <InterceptorRules />
      </div>
      <SchemaRows sections={sections.slice(interceptorIdx + 1)} />
    </div>
  );
}
