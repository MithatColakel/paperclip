import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.roadmap";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "roadmap";

/**
 * v0.1 is read-only: no database namespace, no writes, no jobs, no agent
 * tools. Later phases add capabilities, which puts an installed plugin in
 * `upgrade_pending` until an operator approves (or it is reinstalled).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Roadmap",
  description:
    "A read-only, Jira-like flow board of every task: Hotfix, version lanes from v:<key> labels, Ongoing work, Release ops and Routines, for every project of the company.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "companies.read",
    "projects.read",
    "agents.read",
    "issues.read",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.detailTab.register",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "roadmap-nav",
        displayName: "Roadmap",
        exportName: "RoadmapSidebarLink",
      },
      {
        type: "page",
        id: "roadmap-page",
        displayName: "Roadmap",
        exportName: "RoadmapPage",
        routePath: PAGE_ROUTE,
      },
      {
        type: "detailTab",
        id: "project-roadmap",
        displayName: "Roadmap",
        exportName: "ProjectRoadmapTab",
        entityTypes: ["project"],
      },
      {
        type: "toolbarButton",
        id: "task-version-chip",
        displayName: "Version",
        exportName: "TaskVersionChip",
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
