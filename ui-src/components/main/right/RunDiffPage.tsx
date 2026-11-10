// Run change review page: the host-generated snapshot diff (before/after of one file inside
// one run), not the working-tree git diff. Opened from the chat's file-change card.
import { useAppStore } from "../../../store/index";
import LightweightDiff from "../../diff/LightweightDiff";
import { langOfPath } from "../../../lib/highlighter";
import { splitPath } from "../../chat/util";
import { t } from "../../../i18n";

export default function RunDiffPage() {
  const view = useAppStore((st) => st.runDiffView);
  const { dir, name } = splitPath(view?.path ?? "");
  return (
    <>
      <div className="rb-head">
        <div className="text-ui-sm text-faint mb-1.5 break-all" title={view?.path}>
          {view ? dir + name : t("right.tabRunDiff")}
        </div>
      </div>
      <div className="rb-scroll">
        {!view ? (
          <div className="py-3 text-faint text-ui-base">{t("right.noDiffContent")}</div>
        ) : view.loading ? (
          <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>
        ) : !view.diff ? (
          <div className="py-3 text-faint text-ui-base">{t("right.noDiffContent")}</div>
        ) : (
          <LightweightDiff diff={view.diff} lang={langOfPath(view.path)} className="fd-holder" folded={false} />
        )}
      </div>
    </>
  );
}
