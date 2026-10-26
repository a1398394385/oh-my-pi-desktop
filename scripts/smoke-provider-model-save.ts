// Provider model save smoke (host side): saving one model's metadata must
// not wipe the hand-written keys the editor cannot see (compat/tokenizer/…).
// The editor row owns the metadata keys only — a bare row means "inherit
// everything", which drops those keys but keeps the rest of the line.
//
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-provider-model-save.ts
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { H } = await import("../host/state.ts");
const { Settings } = await import("@oh-my-pi/pi-coding-agent");

const tmp = mkdtempSync(join(tmpdir(), "provider-model-save-"));
const modelsPath = join(tmp, "models.yml");
writeFileSync(
	modelsPath,
	[
		"providers:",
		"  bulita:",
		"    baseUrl: https://example.invalid/v1",
		"    api: openai-completions",
		"    models:",
		"      - id: m1",
		"        name: M1",
		"        contextWindow: 1000000",
		"        tokenizer: deepseek-v3",
		"        compat:",
		"          supportsReasoningEffort: true",
		"          reasoningContentField: reasoning_content",
		"",
	].join("\n"),
);

H.agentDir = tmp;
H.settings = Settings.isolated({});
// The catalog refresh at the tail of the save touches the registry — stub it,
// the save itself is what this smoke covers.
H.modelRegistry = { refresh: async () => {}, getAvailable: () => [] } as unknown as typeof H.modelRegistry;
H.authStorage = { credentials: { list: () => [] }, keys: { source: () => undefined } } as unknown as typeof H.authStorage;

const { wizardHandlers } = await import("../host/rpc/provider-wizard.ts");
const frames: string[] = [];
const ws = { send: (s: string) => frames.push(s) };
const save = wizardHandlers.save_provider_model as unknown as (ws: unknown, msg: unknown) => Promise<void>;

// Edit one metadata field: the hand-written keys must survive.
await save(ws, { provider: "bulita", model: { id: "m1", contextWindow: 200000 } });
const edited = readFileSync(modelsPath, "utf8");
assert(edited.includes("contextWindow: 200000"), `上下文窗口应更新，实际:\n${edited}`);
assert(edited.includes("tokenizer: deepseek-v3"), `tokenizer 不应丢失，实际:\n${edited}`);
assert(edited.includes("reasoningContentField: reasoning_content"), `compat 不应丢失，实际:\n${edited}`);

// Toggle-off (bare row) = inherit everything: the metadata keys go, the rest stays.
await save(ws, { provider: "bulita", model: { id: "m1" } });
const bare = readFileSync(modelsPath, "utf8");
assert(!bare.includes("contextWindow"), `裸行应清掉 contextWindow，实际:\n${bare}`);
assert(!bare.includes("name:"), `裸行应清掉 name，实际:\n${bare}`);
assert(bare.includes("tokenizer: deepseek-v3"), `tokenizer 仍应保留，实际:\n${bare}`);
assert(bare.includes("reasoningContentField: reasoning_content"), `compat 仍应保留，实际:\n${bare}`);

console.log("✓ 单模型元数据保存冒烟通过：手工 compat/tokenizer 不丢，裸行清元数据");
