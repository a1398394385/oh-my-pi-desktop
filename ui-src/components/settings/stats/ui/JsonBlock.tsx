import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText, SUCCESS_FLASH_MS } from "../../../main/sidebar/util";

export interface JsonBlockProps {
  data: unknown;
  title?: string;
  initialCollapsed?: boolean;
}

export function JsonBlock({ data, title = "JSON", initialCollapsed = false }: JsonBlockProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number>(0);
  const json = JSON.stringify(data, null, 2);

  useEffect(() => () => window.clearTimeout(copyResetRef.current), []);

  const copy = async () => {
    await copyText(json);
    setCopied(true);
    window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopied(false), SUCCESS_FLASH_MS);
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button
          type="button"
          className="btn"
          data-variant="ghost"
          data-size="sm"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          {title}
        </button>
        <button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t("common.copied") : t("settingsPage.stats.ui.copy")}
        </button>
      </div>
      {!collapsed && (
        <pre className="code-block">
          <code>{json}</code>
        </pre>
      )}
    </div>
  );
}
