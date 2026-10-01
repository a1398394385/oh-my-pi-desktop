// 编辑行（edit/write/apply_patch 单文件）与「更改」组（连续编辑事件合并 / 多文件单事件）。
// 迁移自 ui/tool-labels.js 的 renderEdit/renderChange/renderChangeGroup/buildChangeBody。
// 行点击展开/收起内联 diff（ed-brief）；首次展开按需向宿主拉取该文件 diff，
// 回包经 file_diff 写入 briefDiffCache 后重渲染。
import type { ToolItem } from "../../types/session";
import { useAppStore } from "../../store/index";
import { bumpGroupExpand, useGroupExpandVersion, rdExpand, chgExpand } from "../../store/groupExpand";
export { rdExpand, chgExpand };
import Icon from "../../Icon";
import { FileChip, Counts, EditBrief, useLift, openFileDiffInSidebar, uniqueFiles, Ellip, ReadRow, Spin, patchActiveItem, patchGroupSub } from "./parts";
import { splitPath } from "./util";
import { t } from "../../i18n";

// 事件涉及的文件清单：优先 tool_update 回填的 files，否则从 args 兜底
function filesOf(item: ToolItem): string[] {
  return uniqueFiles(item.files?.length ? item.files : item.args?.files || (item.args?.path ? [item.args.path] : []));
}

// 展开（收起动画由调用方的 useLift 处理）：置数 + 首次展开按需拉取该文件 diff。
// apply 是落 item 字段的写入通道：顶层行与组内子行各自走对应的拷贝链
function expandDiff(item: ToolItem, path: string, apply: (fn: (it: ToolItem) => void) => void) {
  const st = useAppStore.getState();
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
  // 优先用当次工具回包的真实修改（diffContent）：新文件/无 git 基线时 git diff 只剩
  // 全量新增，与行上 +N-M 摘要对不上。挂在 item 上（非 path 缓存）——同一文件多次
  // 编辑各次展开各看各的；diffContent 缺失（老会话/多文件 patch）回落 git diff
  const willSetBrief = item.diffContent != null && item.briefDiff === undefined;
  apply((it) => {
    it.diffExpanded = true;
    if (willSetBrief) it.briefDiff = item.diffContent;
  });
  // 请求条件在原版里读的是置数后的 item.briefDiff（willSetBrief 置了数即不再请求）
  if (path && !willSetBrief && item.briefDiff === undefined && s?.isGit && st.briefDiffCache.get(path) === undefined && st.briefDiffPending !== path) {
    useAppStore.setState({ briefDiffPending: path }); // 静默写（原 S.xxx 直写不 notify）
    st.send({ type: "get_file_diff", cwd: s.cwd, path });
  }
}

// 编辑行：铅笔 + 「编辑/写入」+ 文件标签（可点开右栏 diff）+ 行数变化 + 展开箭头
export default function EditRow({ item }: { item: ToolItem }) {
  const path = filesOf(item)[0] || "";
  const [closing, close] = useLift();
  const open = item.diffExpanded && !closing;
  const toggle = () => {
    if (item.diffExpanded) close(() => patchActiveItem(item, (it) => { it.diffExpanded = false; }));
    else expandDiff(item, path, (fn) => patchActiveItem(item, fn));
  };
  return (
    <>
      <div className="act edit" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="pencil" size={15} />
        <span className="lbl">{(item.removed ?? 0) > 0 ? t("chat.editLabel") : t("chat.writeLabel")}</span>
        {path ? (
          <FileChip path={path} nameClass="ed-name" onNameClick={() => openFileDiffInSidebar(path)} />
        ) : (
          item.name || item.text || ""
        )}
        <Counts item={item} />
        {item.running && <Spin />}
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {item.diffExpanded && path && <EditBrief item={item} path={path} lift={closing} />}
    </>
  );
}

// 更改组内行 UI：完整编辑标签（标签文字 + 文件 + 行数 + 展开箭头），仅去掉行首铅笔图标
function ChangeRowUI({ sub, open, onToggle }: { sub: ToolItem; open: boolean; onToggle: () => void }) {
  const files = filesOf(sub);
  const path = files[0] || "";
  return (
    <div className="chg-item" style={{ cursor: "pointer" }} onClick={onToggle}>
      <span className="lbl">{(sub.removed ?? 0) > 0 ? t("chat.editLabel") : t("chat.writeLabel")}</span>
      {files.length > 1 ? (
        // 单条事件涉及多文件（apply_patch）：文件标签单行排布，超长行尾出省略号
        <span className="chips-lane">
          {files.map((f) => <FileChip path={f} key={f} />)}{" "}
        </span>
      ) : path ? (
        <FileChip path={path} nameClass="ed-name" onNameClick={() => openFileDiffInSidebar(path)} />
      ) : (
        sub.name || sub.text || ""
      )}
      <Counts item={sub} />
      {sub.running && <Spin />}
      <span className={"ed-arrow" + (open ? " open" : "")}>
        <Icon name="chevronRight" />
      </span>
    </div>
  );
}

// 组内一条编辑事件 = 行 + 其内联 diff 展开体（展开态记在 sub.diffExpanded 上）
function ChangeEntry({ sub }: { sub: ToolItem }) {
  const path = filesOf(sub)[0] || "";
  const [closing, close] = useLift();
  const open = !!sub.diffExpanded && !closing;
  const toggle = () => {
    if (sub.diffExpanded) close(() => patchGroupSub(sub, (it) => { it.diffExpanded = false; }));
    else expandDiff(sub, path, (fn) => patchGroupSub(sub, fn));
  };
  return (
    <>
      <ChangeRowUI sub={sub} open={open} onToggle={toggle} />
      {sub.diffExpanded && path && <EditBrief item={sub} path={path} lift={closing} />}
    </>
  );
}

// 更改组展开状态：以组内首个 item 对象为键（定义于 groupExpand.ts）

// 「更改 · N 个文件」标题行：连续编辑事件合并组，点击向下展开各条编辑
function ChangeGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // 组展开态在模块级 WeakMap 上,靠 groupExpand 通道 bump 触发重渲染
  const fileCount = uniqueFiles(subs.flatMap((g) => filesOf(g))).length; // 0 → "multiple files" fallback
  const [closing, close] = useLift();
  const open = chgExpand.has(subs[0]) && !closing;
  const toggle = () => {
    if (chgExpand.has(subs[0])) close(() => { chgExpand.delete(subs[0]); bumpGroupExpand(); });
    else {
      chgExpand.set(subs[0], true);
      bumpGroupExpand();
    }
  };
  return (
    <>
      <div className="act change" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="pencil" size={15} />
        <span className="lbl">{fileCount ? t("chat.changeFiles", { count: fileCount }) : t("chat.changeFilesMultiple")}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {chgExpand.has(subs[0]) && (
        <div className={"chg-body" + (closing ? " lift" : " drop")}>
          {subs.map((sub, i) => <ChangeEntry sub={sub} key={i} />)}
        </div>
      )}
    </>
  );
}

// 多文件单条编辑事件（apply_patch 一次改多文件）：标签行 + 文件标签列表，无展开
function ChangeSingle({ item }: { item: ToolItem }) {
  const files = filesOf(item);
  return (
    <div className="act change">
      <Icon name="pencil" size={15} />
      <span className="lbl">{files.length ? t("chat.changeFiles", { count: files.length }) : t("chat.changeFilesMultiple")}</span>
      {files.length > 0 && (
        <>
          {" "}<span className="sep">·</span>{" "}
          <span className="chips-lane">
            {files.map((f) => <FileChip path={f} key={f} />)}{" "}
          </span>
        </>
      )}
    </div>
  );
}

export function renderChange(item: ToolItem) {
  // 组成员运行期必为 tool 条目(items.tsx 分组构造),判别联合层面收窄
  if (item.group) return <ChangeGroup subs={item.group as ToolItem[]} />;
  return <ChangeSingle item={item} />;
}

// ---------- 查阅组（连续 read 合并，机制与更改组一致） ----------
// 展开状态：独立 WeakMap（定义于 groupExpand.ts）

// 组内单条读取行：共享 parts.tsx 的 ReadRow（点击展开显示读取内容）
function ReadEntry({ sub }: { sub: ToolItem }) {
  return <ReadRow item={sub} inGroup />;
}

// 「查阅 · N 个文件」标题行：点击向下展开各条读取
function ReadGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // 组展开态在模块级 WeakMap 上,靠 groupExpand 通道 bump 触发重渲染
  const fileCount = uniqueFiles(subs.flatMap((s) => filesOf(s))).length; // 0 → "multiple files" fallback
  const [closing, close] = useLift();
  const open = rdExpand.has(subs[0]) && !closing;
  const toggle = () => {
    if (rdExpand.has(subs[0])) close(() => { rdExpand.delete(subs[0]); bumpGroupExpand(); });
    else {
      rdExpand.set(subs[0], true);
      bumpGroupExpand();
    }
  };
  return (
    <>
      <div className="act read" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="file" size={15} />
        <span className="lbl">{fileCount ? t("chat.readFiles", { count: fileCount }) : t("chat.readFilesMultiple")}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {rdExpand.has(subs[0]) && (
        <div className={"chg-body" + (closing ? " lift" : " drop")}>
          {subs.map((sub, i) => <ReadEntry sub={sub} key={i} />)}
        </div>
      )}
    </>
  );
}

export function renderReadGroup(item: ToolItem) {
  const subs = (item.group ?? []) as ToolItem[]; // 同 renderChange:组成员必为 tool 条目
  return <ReadGroup subs={subs} />;
}
