import { useMemo } from "react";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { TaskVersionInfo } from "../domain/types.ts";
import { roadmapHref } from "./hooks.ts";
import { BoltIcon, EpicIcon } from "./icons.tsx";
import { T, useRoadmapStyles } from "./styles.ts";

export const TASK_VERSION_KEY = "roadmap.taskVersion";

/**
 * Read-only chip on the task page: "Version: mvp", marked "inherited" when the
 * version comes from a parent task. Hidden for Ongoing tasks and routine runs.
 */
export function TaskVersionChip() {
  useRoadmapStyles();
  const context = useHostContext();
  const navigation = useHostNavigation();
  const issueId = context.entityType === "issue" ? context.entityId : null;
  const params = useMemo(() => ({ companyId: context.companyId, issueId }), [context.companyId, issueId]);
  const result = usePluginData<TaskVersionInfo>(TASK_VERSION_KEY, params);

  if (!issueId) return null;
  if (result.error) {
    return (
      <span className="rm-chip" role="status" title={result.error.message} style={{ color: T.muted }}>
        Version unavailable
      </span>
    );
  }
  const info = result.data;
  if (!info || info.kind === "ongoing" || info.kind === "routine" || info.kind === "hidden" || info.kind === "missing") return null;

  const href = roadmapHref(info.projectId, info.projectId ? "flow" : "overview");
  const inheritedTitle = info.inherited
    ? `Inherited from ${info.inheritedFromIdentifier ?? "a parent task"}. Add a v: label to this task to set its own version.`
    : undefined;
  const conflict = info.conflictKeys.length > 1 ? `This task carries ${info.conflictKeys.map((key) => `v:${key}`).join(", ")}; the earliest is used.` : undefined;

  return (
    <a {...navigation.linkProps(href)} className="rm-chip" title={[inheritedTitle, conflict].filter(Boolean).join(" ") || "Open the Roadmap"}>
      {info.kind === "hotfix" || info.isHotfix ? (
        <span className="rm-row" style={{ color: T.destructive, flexWrap: "nowrap" }}>
          <BoltIcon size={3.5} />
          Hotfix
        </span>
      ) : null}
      {info.kind === "epic" ? (
        <span className="rm-row" style={{ flexWrap: "nowrap" }}>
          <EpicIcon size={3.5} />
          Epic
        </span>
      ) : null}
      {info.kind === "release_ops" ? <span>Release ops</span> : null}
      {info.versionKey ? (
        <span>
          Version: <span className="rm-mono">{info.versionKey}</span>
          {info.inherited ? <span style={{ color: T.muted }}> · inherited</span> : null}
          {conflict ? <span style={{ color: T.destructive }}> · {info.conflictKeys.length} labels</span> : null}
        </span>
      ) : null}
    </a>
  );
}
