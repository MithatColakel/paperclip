// @vitest-environment jsdom

// Fork: the company Claude accounts and Devices pages must resolve to their
// own routes, not to the plugin company-settings catch-all declared after them.
// This drives the real <App> route table.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginUiSlotDeclarationSchema } from "@paperclipai/shared";
import { App } from "./App";

// See App.cases-routing.test.tsx: jsdom rejects a CSS rule pulled into <App>'s
// import graph; substitute a benign rule so the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __pap13002Patched?: boolean;
  };
  if (!sheetProto.__pap13002Patched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap13002-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__pap13002Patched = true;
  }
});

vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

// Sentinel pages so the test can tell which route resolved.
vi.mock("./pages/ClaudeAccounts", () => ({ ClaudeAccounts: () => <div>CLAUDE_ACCOUNTS_PAGE</div> }));
vi.mock("./pages/ExecutionDevices", () => ({ ExecutionDevices: () => <div>EXECUTION_DEVICES_PAGE</div> }));
vi.mock("./pages/InstanceAiAccounts", () => ({ InstanceAiAccounts: () => <div>INSTANCE_DEVICES_AND_ACCOUNTS_PAGE</div> }));
vi.mock("./pages/CompanySettingsPluginPage", () => ({
  CompanySettingsPluginPage: () => <div>PLUGIN_SETTINGS_PAGE</div>,
}));

const PAP_COMPANY = {
  id: "company-1",
  name: "Paperclip",
  issuePrefix: "PAP",
  status: "active",
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return root;
}

async function waitForRoute(container: HTMLElement, text: string) {
  await vi.waitFor(() => expect(container.textContent).toContain(text));
}

describe("App Claude accounts and Devices routing (fork)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it.each([
    ["/PAP/company/settings/claude-accounts", "CLAUDE_ACCOUNTS_PAGE"],
    ["/PAP/company/settings/devices", "EXECUTION_DEVICES_PAGE"],
    ["/PAP/company/settings/instance/ai-accounts", "INSTANCE_DEVICES_AND_ACCOUNTS_PAGE"],
  ])("renders %s on its own page, not the plugin settings catch-all", async (path, sentinel) => {
    const root = renderAppAt(container, path);
    await waitForRoute(container, sentinel);
    expect(container.textContent).not.toContain("PLUGIN_SETTINGS_PAGE");
    flushSync(() => root.unmount());
  });

  it("still sends other company settings segments to plugin pages", async () => {
    const root = renderAppAt(container, "/PAP/company/settings/example-plugin-page");
    await waitForRoute(container, "PLUGIN_SETTINGS_PAGE");
    flushSync(() => root.unmount());
  });

  it.each(["claude-accounts", "devices"])("refuses a plugin company settings page that claims %s", (routePath) => {
    // The host route would shadow it without a word, so the manifest is rejected instead.
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "companySettingsPage",
      id: "shadowed-settings",
      displayName: "Shadowed",
      exportName: "ShadowedSettingsPage",
      routePath,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });
});
