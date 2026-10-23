// TTSR rule-injection row: the read-only notice that sits where a Time-Traveling Stream
// Rule rewound the stream and injected itself (host `ttsr` event / replay of the
// `ttsr_injection` entry). Collapsed it reads as "N rules injected · names"; expanding lists
// each rule's description. It borrows the thinking row's visual language (.act icon + chevron,
// .think-body disclosure) because both are read-only process rows, not tool cards.
import type { TtsrItem } from "../../types/session";
import Icon from "../../Icon";
import { useLift, patchActiveItem } from "./parts";
import { t } from "../../i18n";

export default function TtsrRow({ item }: { item: TtsrItem }) {
  const [closing, close, liftRef] = useLift();
  const open = !!item.expanded && !closing;
  const toggle = () => {
    if (item.expanded) close(() => patchActiveItem(item, (it) => { it.expanded = false; }));
    else patchActiveItem(item, (it) => { it.expanded = true; });
  };
  // Historical rows have names only (the disk entry never stores rule bodies)
  const body = item.rules.map((r) => (r.description ? `${r.name}: ${r.description}` : r.name)).join("\n");
  return (
    <>
      <div className="act ttsr" style={{ cursor: "pointer" }} onClick={toggle}>
        <span className="tt-ic"><Icon name="shieldWarn" size={13} /></span>
        <span className="lbl">{t("chat.ttsrInjected", { count: item.rules.length })}</span>
        <span className="lbl-n" title={item.text}>{item.text}</span>
        <span className={"th-more" + (open ? " open" : "")}>
          <Icon name="chevronRight" size={10} />
        </span>
      </div>
      {/* Body stays mounted while closing (gated on expanded alone) so useLift can animate its height before the commit unmounts it */}
      {(item.expanded || closing) && (
        <div ref={liftRef} className="think-body kids-in">
          <div className="think-scroll">{body}</div>
        </div>
      )}
    </>
  );
}
