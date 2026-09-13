// The Settings section registry — the single source of truth for what the
// modal contains. Both the modal chrome (the section list) and the router read
// this, so a section cannot exist in one and not the other.
//
// Slugs are public API: they appear in `/settings/:section` URLs that users
// bookmark and that legacy routes redirect to. Do not rename them.
//
// Components are lazy so opening the modal mounts only the active section.

import { lazy } from "react";
import {
  SlidersHorizontal,
  Sparkles,
  Plug,
  TerminalSquare,
  Activity,
  UserRound,
  type LucideIcon,
} from "lucide-react";

const GeneralSection = lazy(() =>
  import("@/components/settings/GeneralSection").then((m) => ({ default: m.GeneralSection })),
);
const AccountSection = lazy(() =>
  import("@/components/settings/AccountSection").then((m) => ({ default: m.AccountSection })),
);
const ModelsPage = lazy(() => import("@/pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const ExtensionsPage = lazy(() =>
  import("@/pages/ExtensionsPage").then((m) => ({ default: m.ExtensionsPage })),
);
const DashboardPage = lazy(() =>
  import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);

export interface SettingsSection {
  slug: string;
  labelKey: string;
  testId: string;
  icon: LucideIcon;
  Component: React.LazyExoticComponent<React.ComponentType<any>>;
  // Props the section's component needs. ExtensionsPage serves two sections
  // and distinguishes them by this prop.
  props?: Record<string, unknown>;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    slug: "general",
    labelKey: "settings.sections.general",
    testId: "settings-section-general",
    icon: SlidersHorizontal,
    Component: GeneralSection as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "account",
    labelKey: "settings.sections.account",
    testId: "settings-section-account",
    icon: UserRound,
    Component: AccountSection as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "models",
    labelKey: "settings.sections.models",
    testId: "settings-section-models",
    icon: Sparkles,
    Component: ModelsPage as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "mcp",
    labelKey: "settings.sections.mcp",
    testId: "settings-section-mcp",
    icon: Plug,
    Component: ExtensionsPage as React.LazyExoticComponent<React.ComponentType<any>>,
    props: { type: "mcp" },
  },
  {
    slug: "skills",
    labelKey: "settings.sections.skills",
    testId: "settings-section-skills",
    icon: TerminalSquare,
    Component: ExtensionsPage as React.LazyExoticComponent<React.ComponentType<any>>,
    props: { type: "skills" },
  },
  {
    slug: "status",
    labelKey: "settings.sections.status",
    testId: "settings-section-status",
    icon: Activity,
    Component: DashboardPage as React.LazyExoticComponent<React.ComponentType<any>>,
  },
];

export const DEFAULT_SECTION = "general";

export const settingsPath = (slug: string) => `/settings/${slug}`;

// An unrecognized slug resolves to General rather than rendering an empty
// modal — see the settings-surface spec.
export function resolveSection(slug: string | undefined): SettingsSection {
  return (
    SETTINGS_SECTIONS.find((s) => s.slug === slug) ??
    SETTINGS_SECTIONS.find((s) => s.slug === DEFAULT_SECTION)!
  );
}
