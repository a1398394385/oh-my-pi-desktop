// en copy for the composer/approval 18.5 extension domain (ghost completion,
// model capability badges, ask multi-question merged submit). Keys are
// prefixed `compExt.` — see ui-src/i18n/README.md.
export const compExtEn = {
  // ModelMenu.tsx capability badges
  capCache: "cache",
  capWeb: "web",
  capImg: "image",
  // ApprovalCard.tsx ask multi-question paged form
  askMultiHint: "↑/↓ to move · Space checks multi",
  askPrev: "Previous",
  askNext: "Next",
  askSubmitAll: "Submit answers",
  askOther: "Other:",
  askOtherPlaceholder: "Type your answer…",
  // AskFormCard.tsx: one HTML form drawn whole (18.20 uiCtx.formDialog)
  askFormRequired: "Answer “{{name}}” to submit",
  askFormHint: "Every answer submits together",
  askFormDeadline: "Submits the default answers in {{s}}s",
  askFormDeadlineShort: "{{s}}s",
  askFormNote: "(optional) add a note, sent with your answer",
};

export default compExtEn;
