import { useHostLocation, useHostNavigation, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { PAGE_PATH } from "./hooks.ts";
import { RoadmapIcon } from "./icons.tsx";
import { useRoadmapStyles } from "./styles.ts";

/** "Roadmap" in the sidebar's Work section (both shells). Active on every Roadmap route. */
export function RoadmapSidebarLink(_props: PluginSidebarProps) {
  useRoadmapStyles();
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const href = navigation.resolveHref(PAGE_PATH);
  const active = location.pathname === href || location.pathname.startsWith(`${href}/`);
  return (
    <a {...navigation.linkProps(PAGE_PATH)} className="rm-navlink" aria-current={active ? "page" : undefined}>
      <RoadmapIcon />
      <span className="rm-truncate" style={{ flex: "1 1 auto" }}>
        Roadmap
      </span>
    </a>
  );
}
