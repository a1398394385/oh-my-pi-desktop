// API-equivalent pricing from the bundled catalog, for journals that recorded no cost.
//
// A journal stores the runtime's `usage.cost`, which is zero whenever the provider
// reports none — subscription plans such as zhipu-coding-plan carry an explicit 0
// card — or the model has no row for that provider at all. The stats dashboard is
// an API-equivalent estimate, so a zero-cost request is repriced by model id: the
// provider's own billable card, then its pricing peers, then the same id on any
// bundled provider (a coding-plan row prices the model at 0 while `zai` prices it
// at list rate).
//
// The module is loaded lazily by the stats endpoints: it pulls the 13MB bundled
// catalog, which the model registry has usually loaded already.
import { pricingPeerFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import {
  calculateUsageCost,
  getBundledModel,
  getBundledModels,
  getBundledProviders,
  isGeneratedProvider,
} from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, Usage } from "@oh-my-pi/pi-catalog/types";

export type UsagePricer = (provider: string, modelId: string, usage: Usage, timestamp: number) => Usage["cost"] | null;

const billable = (cost: ModelCost): boolean =>
  cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;

function ownCost(provider: string, modelId: string): ModelCost | null {
  if (!isGeneratedProvider(provider)) return null;
  return getBundledModel(provider, modelId)?.cost ?? null;
}

/** model id → first billable card on any bundled provider, built once per process. */
let byId: Map<string, ModelCost> | null = null;

function firstBillableById(modelId: string): ModelCost | null {
  if (!byId) {
    byId = new Map();
    for (const provider of getBundledProviders()) {
      for (const model of getBundledModels(provider)) {
        if (billable(model.cost) && !byId.has(model.id)) byId.set(model.id, model.cost);
      }
    }
  }
  return byId.get(modelId) ?? null;
}

/** The billable card for a provider model id, or null when no bundled row prices it. */
export function catalogCostFor(provider: string, modelId: string): ModelCost | null {
  const own = ownCost(provider, modelId);
  if (own && billable(own)) return own;
  const peer = pricingPeerFor(provider, modelId);
  if (peer) {
    for (const peerProvider of peer.peers) {
      const cost = ownCost(peerProvider, peer.peerId);
      if (cost && billable(cost)) return cost;
    }
  }
  return firstBillableById(modelId);
}

/** Price one request at its timestamp; null when no bundled row prices the model. */
export const priceUsage: UsagePricer = (provider, modelId, usage, timestamp) => {
  const cost = catalogCostFor(provider, modelId);
  if (!cost) return null;
  return calculateUsageCost(
    cost,
    { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp || undefined,
  );
};
