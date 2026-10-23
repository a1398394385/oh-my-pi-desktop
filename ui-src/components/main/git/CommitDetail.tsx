// Right column of the Git page: the selected commit, split into its message
// (top) and its numstat file rows (bottom) by a drag separator. A file row click
// opens the compare view in place of the working-changes list and the graph.
import Icon from "../../../Icon";
import { useTranslation } from "react-i18next";
import type { GitCommitDetailFrame, GitCommitFileWire } from "../../../types/frames";
import FileList from "./file-list";
import { fullDate } from "./CommitRow";
import SplitHandle from "./SplitHandle";

export default function CommitDetail({
  detail,
  loading,
  error,
  fileView,
  onToggleFileView,
  selectedPath,
  onOpenFile,
  onSelectCommit,
}: {
  detail: GitCommitDetailFrame | null;
  loading: boolean;
  error: string | null;
  fileView: "flat" | "tree";
  onToggleFileView: () => void;
  selectedPath: string | null;
  onOpenFile: (file: GitCommitFileWire) => void;
  onSelectCommit: (oid: string) => void;
}) {
  const { t } = useTranslation();
  const files = detail?.files ?? [];
  return (
    <aside className="gp-detail">
      <div className="gp-detail-top">
        {loading ? (
          <div className="gp-empty">{t("gitPage.detailLoading")}</div>
        ) : error ? (
          <div className="gp-empty gp-error">{error}</div>
        ) : !detail?.commit ? (
          <div className="gp-empty">{t("gitPage.detailEmpty")}</div>
        ) : (
          <div className="gp-detail-meta-scroll">
            <div className="gp-detail-meta">
              <span className="gp-sha">{detail.commit.oid.slice(0, 7)}</span>
              <Icon name="comment" size={12} style={{ color: "var(--faint)" }} />
              <span className="gp-detail-author">{detail.commit.author}</span>
              <span className="gp-dot">·</span>
              <span>{fullDate(detail.commit.authorTime)}</span>
            </div>
            <div className="gp-detail-subject">{detail.commit.subject}</div>
            {detail.commit.body && <div className="gp-detail-body">{detail.commit.body}</div>}
            <div className="gp-detail-sep" />
            <div className="gp-detail-parents">
              {detail.commit.parents.length > 0 ? (
                <>
                  <span className="gp-parents-label">{t("gitPage.parent")}</span>
                  {detail.commit.parents.map((parent) => (
                    <button
                      type="button"
                      key={parent}
                      className="gp-parent"
                      onClick={() => onSelectCommit(parent)}
                    >
                      {parent.slice(0, 7)}
                    </button>
                  ))}
                </>
              ) : (
                <span className="gp-parents-label">{t("gitPage.rootCommit")}</span>
              )}
              <span className="sp" />
              {detail.commitCount !== null && detail.commitCount !== undefined && (
                <span>{t("gitPage.commitCount", { n: detail.commitCount })}</span>
              )}
            </div>
          </div>
        )}
      </div>
      <SplitHandle kind="right" />
      <div className="gp-detail-files">
        <div className="gp-detail-files-head">
          <span>{t("gitPage.filesChanged", { n: files.length })}</span>
          {(detail?.additions ?? 0) > 0 && <span className="gp-add">+{detail?.additions}</span>}
          {(detail?.deletions ?? 0) > 0 && <span className="gp-del">-{detail?.deletions}</span>}
          <span className="sp" />
          <button
            type="button"
            className="gp-file-view"
            title={fileView === "flat" ? t("gitPage.viewTree") : t("gitPage.viewFlat")}
            onClick={onToggleFileView}
          >
            <Icon name={fileView === "flat" ? "tree" : "list"} size={13} />
          </button>
        </div>
        <div className="gp-detail-files-scroll">
          {detail?.commit && (
            <FileList
              files={files}
              view={fileView}
              binaryLabel={t("gitPage.fileBinary")}
              selectedPath={selectedPath}
              onOpen={onOpenFile}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
