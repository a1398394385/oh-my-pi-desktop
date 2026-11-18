// zh copy for the composer/approval 18.5 extension domain (ghost completion,
// model capability badges, ask multi-question merged submit). Keys are
// prefixed `compExt.` — see ui-src/i18n/README.md.
export const compExtZh = {
  // ModelMenu.tsx capability badges
  capCache: "缓存",
  capWeb: "联网",
  capImg: "图像",
  // ApprovalCard.tsx ask multi-question paged form
  askMultiHint: "↑/↓ 切换选项 · 空格勾选多选",
  askPrev: "上一题",
  askNext: "下一题",
  askSubmitAll: "提交全部答案",
  askOther: "其他：",
  askOtherPlaceholder: "输入你的回答…",
  // AskFormCard.tsx: 整张 HTML 表单（18.20 uiCtx.formDialog）
  askFormRequired: "请先填写“{{name}}”",
  askFormHint: "所有答案一起提交",
  askFormDeadline: "{{s}}s 后按默认答案提交",
  askFormDeadlineShort: "{{s}}s",
  askFormNote: "（可选）加一条批注随答案一起提交",
};

export default compExtZh;
