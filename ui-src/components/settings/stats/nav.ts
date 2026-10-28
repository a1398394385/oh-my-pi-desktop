import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import {
  Activity,
  CircleAlert,
  Coins,
  Cpu,
  FolderGit2,
  Frown,
  Layers,
  LayoutGrid,
  type LucideIcon,
  PlugZap,
  Sparkles,
  SquareChartGantt,
  Wrench,
} from "lucide-react";
import { useAppStore } from "../../../store";

export type DashboardSection =
  | "overview"
  | "models"
  | "providers"
  | "costs"
  | "requests"
  | "errors"
  | "traces"
  | "tools"
  | "frustration"
  | "projects"
  | "gain"
  | "acp";

export interface NavItem {
  id: DashboardSection;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  heading: string;
  items: readonly NavItem[];
}

/** Sidebar navigation; labels resolve through i18n at render time. */
export function useNav(): readonly NavGroup[] {
  const { t } = useTranslation();
  // The ACP section only exists while custom compaction is on: with it off no
  // session writes acpSummary entries, so the section would be permanently empty.
  const acpEnabled = useAppStore((s) => s.hostSettings?.acpEnabled === true);
  return useMemo(
    () => [
      {
        heading: t("settingsPage.stats.nav.groupUsage"),
        items: [
          { id: "overview", label: t("settingsPage.stats.nav.overview"), icon: LayoutGrid },
          { id: "models", label: t("settingsPage.stats.nav.models"), icon: Cpu },
          { id: "providers", label: t("settingsPage.stats.nav.providers"), icon: PlugZap },
          { id: "costs", label: t("settingsPage.stats.nav.costs"), icon: Coins },
        ],
      },
      {
        heading: t("settingsPage.stats.nav.groupActivity"),
        items: [
          { id: "requests", label: t("settingsPage.stats.nav.requests"), icon: Activity },
          { id: "errors", label: t("settingsPage.stats.nav.errors"), icon: CircleAlert },
          { id: "traces", label: t("settingsPage.stats.nav.traces"), icon: SquareChartGantt },
        ],
      },
      {
        heading: t("settingsPage.stats.nav.groupPerformance"),
        items: [
          { id: "tools", label: t("settingsPage.stats.nav.tools"), icon: Wrench },
          { id: "frustration", label: t("settingsPage.stats.nav.frustration"), icon: Frown },
          { id: "projects", label: t("settingsPage.stats.nav.projects"), icon: FolderGit2 },
          { id: "gain", label: t("settingsPage.stats.nav.gain"), icon: Sparkles },
        ],
      },
      ...(acpEnabled
        ? [
            {
              heading: t("settingsPage.stats.nav.groupAcp"),
              items: [{ id: "acp" as const, label: t("settingsPage.stats.nav.acp"), icon: Layers }],
            },
          ]
        : []),
    ],
    [t, acpEnabled],
  );
}
