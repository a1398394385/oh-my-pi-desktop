// Multi-account priority-order UI smoke: the models page renders the account
// rank badge (#1 in-use / #2) on each quota card and the up/down buttons
// emit provider_reorder_account with the swapped id order.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-model-page-order.tsx
import { strict as assert } from "node:assert";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createSmokeWindow } from "./ui-smoke-env";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// React-dependent modules below load dynamically on purpose (same as every
// smoke-*.tsx here): they must initialize only after createSmokeWindow
// installs the DOM — a static top-level import breaks rendering under happy-dom.
const { initI18n } = await import("../ui-src/i18n");
await initI18n("zh-CN");
const { useAppStore, setBump } = await import("../ui-src/store");
const { default: ModelPage } = await import("../ui-src/components/settings/pages/ModelPage");

const sent: Array<Record<string, unknown>> = [];
useAppStore.setState({
  send: (obj: unknown) => sent.push(obj as Record<string, unknown>),
  modelCatalog: [
    { id: "minimax/MiniMax-M2", name: "MiniMax M2", provider: "minimax", kind: "chat", enabled: true, context: 200000, vision: false, efforts: null, authSource: "cred" },
  ],
  providerLimits: {
    type: "provider_limits_result",
    provider: "minimax",
    label: "MiniMax",
    unsupported: false,
    status: "ok",
    planLabel: "Coding Plan",
    accountLabel: "",
    balance: null,
    windows: [],
    updatedAt: null,
    // accounts[0] is the served account; the host serves list order [1, 2].
    accounts: [
      { id: "1", label: "…aaaa", status: "ok", planLabel: "Coding Plan", accountLabel: "", balance: null, windows: [], updatedAt: null },
      { id: "2", label: "…bbbb", status: "ok", planLabel: "Coding Plan", accountLabel: "", balance: null, windows: [], updatedAt: null },
    ],
  },
  providerAccounts: {
    type: "provider_accounts",
    provider: "minimax",
    active: [
      { id: 1, label: "" },
      { id: 2, label: "" },
    ],
    disabled: [],
  },
  selectedProvider: "minimax",
  mpAddView: false,
  mpRolesView: false,
  mpCycleView: false,
  mpDetailProv: null,
});
setBump({});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

try {
  await act(async () => root.render(createElement(ModelPage)));

  const cards = [...host.querySelectorAll(".lx-sec")];
  assert.equal(cards.length, 2, `双账号应渲染两张配额卡，实际 ${cards.length}`);

  const headText = (card: Element) => card.querySelector(".lx-head")?.textContent ?? "";
  assert(headText(cards[0]!).includes("#1 · 生效中"), `首位卡应显示生效中徽标: ${headText(cards[0]!)}`);
  assert(headText(cards[1]!).includes("#2"), `次位卡应显示 #2: ${headText(cards[1]!)}`);

  // The reorder is only observable if each card names its account — two
  // identity-less rows render identically and the move looks like a no-op.
  const ident = (card: Element) => card.querySelector(".lx-prov")?.textContent ?? "";
  assert.equal(ident(cards[0]!), "…aaaa", `首卡应显示账号标识: "${ident(cards[0]!)}"`);
  assert.equal(ident(cards[1]!), "…bbbb", `次卡应显示账号标识: "${ident(cards[1]!)}"`);

  const btns = (card: Element) => [...card.querySelectorAll(".lx-head .icon-btn")] as HTMLButtonElement[];
  const up = (card: Element) => btns(card)[0]!;
  const down = (card: Element) => btns(card)[1]!;
  assert.equal(btns(cards[0]!).length, 2, "首位卡应有上移/下移两个按钮");
  assert.equal(up(cards[0]!).disabled, true, "首位卡上移应禁用");
  assert.equal(down(cards[0]!).disabled, false, "首位卡下移应可用");
  assert.equal(up(cards[1]!).disabled, false, "次位卡上移应可用");
  assert.equal(down(cards[1]!).disabled, true, "次位卡下移应禁用");

  sent.length = 0;
  await act(async () => up(cards[1]!).click());
  const reorder = sent.find((f) => f.type === "provider_reorder_account");
  assert(!!reorder, "点击上移应发送 provider_reorder_account");
  assert.deepEqual(reorder!.ids, [2, 1], "上移应把 B 提到首位");
  assert.equal(reorder!.provider, "minimax", "排序帧应带上 provider");
  assert(
    sent.some((f) => f.type === "get_provider_limits"),
    "排序后应重查配额帧以刷新卡片顺序",
  );

  console.log("✓ 账号优先级 UI 冒烟通过：序号徽标、按钮边界、上移发帧");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
process.exit(0);
