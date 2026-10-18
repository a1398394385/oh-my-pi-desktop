// Right-panel commit-diff viewer: one file's patch inside a commit, opened
// from the Git page's detail file rows. The target lives in the store
// (right slice `commitDiff`); the request/landing lives in store/git-graph.ts
// (openCommitFileDiff), so the tab renders whatever target was last clicked.
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import { langOfPath } from "../../../lib/highlighter";
import LightweightDiff from "../../diff/LightweightDiff";

export default function CommitDiffPage() {
  const { t } = useTranslation();
  const target = useAppStore((s) => s.commitDiff);
  if (!target) {
    return (
      <div className="rb-scroll">
        <div className="py-3 text-faint text-ui-base">{t("right.noDiffContent")}</div>
      </div>
    );
  }
  return (
    <>
      <div className="rb-head">
        <div className="text-ui-sm text-faint mb-1.5 break-all">{target.path}</div>
        <div className="text-ui-xs text-faint font-mono">{target.oid.slice(0, 7)}</div>
      </div>
      <div className="rb-scroll">
        {target.loading ? (
          <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>
        ) : target.error ? (
          <div className="py-3 text-err text-ui-base">{target.error}</div>
        ) : !target.diff ? (
          <div className="py-3 text-faint text-ui-base">{t("right.noDiffContent")}</div>
        ) : !/\n@@/.test(`\n${target.diff}`) ? (
          // No hunk body: binary file, mode-only change or pure rename — the
          // numstat row still shows counts, so say why the patch is empty
          // instead of repeating the generic placeholder.
          <div className="py-3 text-faint text-ui-base">{t("gitPage.noTextDiff")}</div>
        ) : (
          <LightweightDiff diff={target.diff} lang={langOfPath(target.path)} className="fd-holder" />
        )}
      </div>
    </>
  );
}
