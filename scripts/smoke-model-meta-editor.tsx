// Provider-detail model metadata editor smoke: the custom metadata a
// models.yml config-layer provider already carries must be visible in the
// model page — the "custom metadata" tag on the model row, the metadata
// toggle ON in the editor, and the saved values prefilled (saved beats the
// bundled catalog). Saving must send the bare models.yml row id, not the
// "provider/model" catalog id.
//
// Regression guard: the provider_model_meta snapshot is keyed by the bare
// models.yml row id while the catalog carries "provider/model" — mixing the
// two silently drops every saved metadata (no tag, toggle off, empty fields)
// and would write a bogus "provider/model" row back into models.yml.
//
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-model-meta-editor.tsx
import { strict as assert } from "node:assert";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createSmokeWindow } from "./ui-smoke-env";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// React-dependent modules load dynamically on purpose (same as every
// smoke-*.tsx here): they must initialize only after createSmokeWindow
// installs the DOM — a static top-level import breaks rendering under happy-dom.
const { initI18n } = await import("../ui-src/i18n");
await initI18n("zh-CN");
const { useAppStore, setBump } = await import("../ui-src/store");
const { default: ModelPage } = await import("../ui-src/components/settings/pages/ModelPage");

const sent: Array<Record<string, unknown>> = [];
useAppStore.setState({
	send: (obj: unknown) => sent.push(obj as Record<string, unknown>),
	// Catalog ids are "provider/model"
	modelCatalog: [
		{
			id: "bulita/deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			provider: "bulita",
			kind: "chat",
			enabled: true,
			efforts: null,
			context: 1000000,
			vision: false,
			authSource: "config",
			cred: false,
		},
	],
	// provider_model_meta reply: rows keyed by the bare models.yml row id
	providerMeta: {
		provider: "bulita",
		exists: true,
		rows: {
			"deepseek-v4.1-flash": {
				saved: {
					name: "DeepSeek V4.1 Flash",
					contextWindow: 1000000,
					maxTokens: 393216,
					reasoning: true,
					input: ["text"],
					supportsTools: null,
					thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "high" },
					cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
				},
				catalog: {
					name: "DeepSeek V4.1 Flash",
					contextWindow: 1048576,
					maxTokens: 384000,
					reasoning: true,
					input: ["text", "image"],
					supportsTools: null,
					thinking: { mode: "effort", efforts: ["low", "high", "max"] },
					cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
				},
			},
		},
	},
	selectedProvider: "bulita",
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

	// The row carries the custom-metadata tag (host snapshot keyed by row id)
	const tag = host.querySelector(".mp-row .mpw-cat");
	assert(tag, "模型行应显示「自定义元数据」标签");
	assert.equal(tag!.textContent, "自定义元数据", `标签文案应为「自定义元数据」，实际 ${tag!.textContent}`);

	// Expand the metadata editor (caret button only exists for config providers)
	const caret = host.querySelector(".mp-row .mpw-caret") as HTMLButtonElement | null;
	assert(caret, "配置层 provider 的模型行应有元数据展开按钮");
	await act(async () => caret!.click());

	const editor = host.querySelector(".mem-expand");
	assert(editor, "点击后应展开元数据编辑器");

	// The toggle reflects the persisted state: saved metadata = toggle on
	const toggle = editor!.querySelector(".mpw-meta-head .tg");
	assert(toggle?.classList.contains("on"), "已保存自定义元数据时开关应处于开启态");

	// Prefill: saved value wins over the bundled catalog (1000000, not 1048576)
	const numbers = [...editor!.querySelectorAll(".mcp-inp-num")] as HTMLInputElement[];
	assert.equal(numbers[0]?.value, "1000000", `上下文窗口应预填已保存值 1000000，实际 ${numbers[0]?.value}`);
	assert.equal(numbers[1]?.value, "393216", `最大输出应预填已保存值 393216，实际 ${numbers[1]?.value}`);
	assert.equal(numbers[0]?.disabled, false, "开关开启时元数据输入框应可编辑");

	// Saving sends the bare models.yml row id
	sent.length = 0;
	const save = editor!.querySelector(".mpw-meta-foot .save-btn") as HTMLButtonElement;
	await act(async () => save.click());
	const frame = sent.find((f) => f.type === "save_provider_model");
	assert(frame, "点击保存应发送 save_provider_model");
	const model = frame!.model as { id: string };
	assert.equal(model.id, "deepseek-v4.1-flash", `保存的模型 id 应为裸 id，实际 ${model.id}`);

	// The save reply lands the persisted row as the "saved" snapshot — the
	// capability fields must survive it (a name/ctx-only snapshot would read
	// the saved thinking/input block back as "inherit" on the next open).
	const { frameHandlers } = await import("../ui-src/store/wsHandlers");
	await act(async () => {
		(frameHandlers.provider_model_saved as (msg: unknown) => void)({
			type: "provider_model_saved",
			provider: "bulita",
			model: {
				id: "deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				contextWindow: 1000000,
				maxTokens: 393216,
				reasoning: true,
				input: ["text"],
				thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "high" },
				cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
			},
		});
	});
	const landed = useAppStore.getState().providerMeta?.rows["deepseek-v4.1-flash"]?.saved;
	assert(landed, "保存回显应更新 saved 快照");
	assert.equal(landed!.thinking?.defaultLevel, "high", "保存回显应保留 thinking 配置");
	assert.deepEqual(landed!.input, ["text"], "保存回显应保留 input 模态");
	assert.equal(landed!.reasoning, true, "保存回显应保留 reasoning 开关");

	console.log("✓ 模型自定义元数据 UI 冒烟通过：标签、开关、预填、保存 id、保存回显");
} finally {
	await act(async () => root.unmount());
}
process.exit(0);
