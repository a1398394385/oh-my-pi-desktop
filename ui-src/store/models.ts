// Model data shared by the composer and settings; scoped chat candidates and the
// complete catalog remain distinct views of the same host registry.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import type { ModelCatalogEntry, ModelRoleEntry } from "../types/frames";

/** Model capability axes appended to models-frame entries (contract v1: promptCache = keepalive tier seconds) */
export interface ModelCaps {
  promptCache?: number;
  webSearch?: boolean;
  imageGen?: boolean;
}

export interface ModelsSlice {
  modelNames: Map<string, string>;
  modelEfforts: Map<string, string[]>;
  modelCaps: Map<string, ModelCaps>;
  modelCatalog: ModelCatalogEntry[];
  modelRoles: ModelRoleEntry[] | null;
  defaultModelCfg: string | null;
  defaultThinkingCfg: string | null;
}

export const createModelsSlice: StateCreator<AppStore, [], [], ModelsSlice> = () => ({
  modelNames: new Map(),
  modelEfforts: new Map(),
  modelCaps: new Map(),
  modelCatalog: [],
  modelRoles: null,
  defaultModelCfg: null,
  defaultThinkingCfg: null,
});

// ---------- Model catalog (moved over from composer.js ingestModels; changes swap Map references) ----------
// The models frame is a full scopedModels snapshot (ready / models / enable-disable pushes agree),
// rebuilt per frame instead of merged: merging would leave disabled models lingering in the
// composer menu
export function ingestModels(
  models?: {
    id: string;
    name?: string | null;
    efforts?: string[] | null;
    promptCache?: number;
    webSearch?: boolean;
    imageGen?: boolean;
  }[],
): void {
  useAppStore.setState(() => {
    if (!models?.length) return {};
    const modelNames = new Map<string, string>();
    const modelEfforts = new Map<string, string[]>();
    const modelCaps = new Map<string, ModelCaps>();
    for (const m of models) {
      modelNames.set(m.id, m.name || m.id);
      if (Array.isArray(m.efforts)) modelEfforts.set(m.id, m.efforts);
      // Capability axes land only when the host reports them (wire-absent
      // fields stay absent in the map)
      if (m.promptCache !== undefined || m.webSearch !== undefined || m.imageGen !== undefined) {
        modelCaps.set(m.id, { promptCache: m.promptCache, webSearch: m.webSearch, imageGen: m.imageGen });
      }
    }
    return { modelNames, modelEfforts, modelCaps };
  });
}

export function getSupportedThinkingForModel(modelId: string | null | undefined): string[] {
  const efforts = useAppStore.getState().modelEfforts.get(modelId ?? "") ?? [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

// Extract new-session config defaults from models/ready frames
export function ingestModelDefaults(msg: { defaultModel?: string | null; defaultThinking?: string | null }): boolean {
  const has = "defaultModel" in msg || "defaultThinking" in msg;
  if (!has) return false;
  useAppStore.setState({ defaultModelCfg: msg.defaultModel ?? null, defaultThinkingCfg: msg.defaultThinking ?? null });
  return true;
}

